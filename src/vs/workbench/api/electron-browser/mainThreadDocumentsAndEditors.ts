/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IModelService } from 'vs/editor/common/services/modelService';
import { IModel, ICommonCodeEditor, isCommonCodeEditor, isCommonDiffEditor } from 'vs/editor/common/editorCommon';
import { compare } from 'vs/base/common/strings';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ICodeEditorService } from 'vs/editor/common/services/codeEditorService';
import Event, { Emitter } from 'vs/base/common/event';
import { ExtHostContext, ExtHostDocumentsAndEditorsShape, IModelAddedData, ITextEditorAddData, IDocumentsAndEditorsDelta, IExtHostContext, MainContext } from '../node/extHost.protocol';
import { MainThreadTextEditor } from './mainThreadEditor';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Position as EditorPosition, IEditor } from 'vs/platform/editor/common/editor';
import { extHostCustomer } from 'vs/workbench/api/electron-browser/extHostCustomers';
import { MainThreadDocuments } from 'vs/workbench/api/electron-browser/mainThreadDocuments';
import { MainThreadEditors } from 'vs/workbench/api/electron-browser/mainThreadEditors';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IFileService } from 'vs/platform/files/common/files';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

namespace cmp {
	export function compareModels(a: IModel, b: IModel): number {
		return compare(a.uri.toString(), b.uri.toString());
	}
	export function compareEditors(a: EditorAndModel, b: EditorAndModel): number {
		let ret = compare(a.editor.getId(), b.editor.getId());
		if (ret === 0) {
			ret = compare(a.document.uri.toString(), b.document.uri.toString());
		}
		return ret;
	}
	export function modelKey(a: IModel): string {
		return a.uri.toString();
	}
	export function editorsKey(a: EditorAndModel): string {
		return `${a.editor.getId()} ${a.document.uri.toString()}`;
	}
	export function delta<T>(before: T[], after: T[], key: (a: T) => string): { removed: T[], added: T[] } {
		const removedMap: Record<string, T> = {};
		for (const v of before) {
			removedMap[key(v)] = v;
		}

		const added: T[] = [];
		for (const v of after) {
			const k = key(v);
			if (k in removedMap) {
				delete removedMap[k];
			} else {
				added.push(v);
			}
		}

		const removed: T[] = [];
		for (const k in removedMap) {
			removed.push(removedMap[k]);
		}

		return { removed, added };
	}
}

class EditorAndModel {

	readonly id: string;

	constructor(
		readonly editor: ICommonCodeEditor,
		readonly document: IModel,
	) {
		this.id = `${editor.getId()},${document.uri.toString()}`;
	}
}

class DocumentAndEditorStateDelta {

	readonly isEmpty: boolean;

	constructor(
		readonly removedDocuments: IModel[],
		readonly addedDocuments: IModel[],
		readonly removedEditors: EditorAndModel[],
		readonly addedEditors: EditorAndModel[],
		readonly oldActiveEditor: string,
		readonly newActiveEditor: string,
	) {
		this.isEmpty = this.removedDocuments.length === 0
			&& this.addedDocuments.length === 0
			&& this.removedEditors.length === 0
			&& this.addedEditors.length === 0
			&& oldActiveEditor === newActiveEditor;
	}

	toString(): string {
		let ret = 'DocumentAndEditorStateDelta\n';
		ret += `\tRemoved Documents: [${this.removedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tAdded Documents: [${this.addedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tRemoved Editors: [${this.removedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tAdded Editors: [${this.addedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tNew Active Editor: ${this.newActiveEditor}\n`;
		return ret;
	}
}

class DocumentAndEditorState {

	static compute(before: DocumentAndEditorState, after: DocumentAndEditorState): DocumentAndEditorStateDelta {
		if (!before) {
			return new DocumentAndEditorStateDelta([], after.documents, [], after.editors, undefined, after.activeEditor);
		}
		const documentDelta = cmp.delta(before.documents, after.documents, cmp.modelKey);
		const editorDelta = cmp.delta(before.editors, after.editors, cmp.editorsKey);
		const oldActiveEditor = before.activeEditor !== after.activeEditor ? before.activeEditor : undefined;
		const newActiveEditor = before.activeEditor !== after.activeEditor ? after.activeEditor : undefined;

		return new DocumentAndEditorStateDelta(
			documentDelta.removed, documentDelta.added,
			editorDelta.removed, editorDelta.added,
			oldActiveEditor, newActiveEditor
		);
	}

	constructor(
		readonly documents: IModel[],
		readonly editors: EditorAndModel[],
		readonly activeEditor: string,
	) {
	}
}

class MainThreadDocumentAndEditorStateComputer {

	private _toDispose: IDisposable[] = [];
	private _toDisposeOnEditorRemove = new Map<string, IDisposable>();
	private _currentState: DocumentAndEditorState;

	constructor(
		private readonly _onDidChangeState: (delta: DocumentAndEditorStateDelta) => void,
		@IModelService private _modelService: IModelService,
		@ICodeEditorService private _codeEditorService: ICodeEditorService,
		@IWorkbenchEditorService private _workbenchEditorService: IWorkbenchEditorService
	) {
		this._modelService.onModelAdded(this._updateState, this, this._toDispose);
		this._modelService.onModelRemoved(this._updateState, this, this._toDispose);

		this._codeEditorService.onCodeEditorAdd(this._onDidAddEditor, this, this._toDispose);
		this._codeEditorService.onCodeEditorRemove(this._onDidRemoveEditor, this, this._toDispose);
		this._codeEditorService.listCodeEditors().forEach(this._onDidAddEditor, this);

		this._updateState();
	}

	dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	private _onDidAddEditor(e: ICommonCodeEditor): void {
		this._toDisposeOnEditorRemove.set(e.getId(), e.onDidChangeModel(() => this._updateState()));
		this._toDisposeOnEditorRemove.set(e.getId(), e.onDidFocusEditor(() => this._updateState()));
		this._toDisposeOnEditorRemove.set(e.getId(), e.onDidBlurEditor(() => this._updateState()));
		this._updateState();
	}

	private _onDidRemoveEditor(e: ICommonCodeEditor): void {
		const sub = this._toDisposeOnEditorRemove.get(e.getId());
		if (sub) {
			this._toDisposeOnEditorRemove.delete(e.getId());
			sub.dispose();
			this._updateState();
		}
	}

	private _updateState(): void {

		// models: ignore too large models
		const models = this._modelService.getModels();
		for (let i = 0; i < models.length; i++) {
			if (models[i].isTooLargeForHavingARichMode()) {
				models.splice(i, 1);
				i--;
			}
		}

		// editor: only take those that have a not too large model
		const editors: EditorAndModel[] = [];
		let activeEditor: string = null;

		for (const editor of this._codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			if (model && !model.isTooLargeForHavingARichMode()
				&& !model.isDisposed() // model disposed
				&& Boolean(this._modelService.getModel(model.uri)) // model disposing, the flag didn't flip yet but the model service already removed it
			) {
				const apiEditor = new EditorAndModel(editor, model);
				editors.push(apiEditor);
				if (editor.isFocused()) {
					activeEditor = apiEditor.id;
				}
			}
		}

		// active editor: if none of the previous editors had focus we try
		// to match the action workbench editor with one of editor we have
		// just computed
		if (!activeEditor) {
			const workbenchEditor = this._workbenchEditorService.getActiveEditor();
			if (workbenchEditor) {
				const workbenchEditorControl = workbenchEditor.getControl();
				let candidate: ICommonCodeEditor;
				if (isCommonCodeEditor(workbenchEditorControl)) {
					candidate = workbenchEditorControl;
				} else if (isCommonDiffEditor(workbenchEditorControl)) {
					candidate = workbenchEditorControl.getModifiedEditor();
				}
				if (candidate) {
					for (const { editor, id } of editors) {
						if (candidate === editor) {
							activeEditor = id;
							break;
						}
					}
				}
			}
		}

		// compute new state and compare against old
		const newState = new DocumentAndEditorState(models, editors, activeEditor);
		const delta = DocumentAndEditorState.compute(this._currentState, newState);
		if (!delta.isEmpty) {
			this._currentState = newState;
			this._onDidChangeState(delta);
		}
	}
}

@extHostCustomer
export class MainThreadDocumentsAndEditors {

	private _toDispose: IDisposable[];
	private _proxy: ExtHostDocumentsAndEditorsShape;
	private _stateComputer: MainThreadDocumentAndEditorStateComputer;
	private _editors = <{ [id: string]: MainThreadTextEditor }>Object.create(null);

	private _onTextEditorAdd = new Emitter<MainThreadTextEditor[]>();
	private _onTextEditorRemove = new Emitter<string[]>();
	private _onDocumentAdd = new Emitter<IModel[]>();
	private _onDocumentRemove = new Emitter<string[]>();

	readonly onTextEditorAdd: Event<MainThreadTextEditor[]> = this._onTextEditorAdd.event;
	readonly onTextEditorRemove: Event<string[]> = this._onTextEditorRemove.event;
	readonly onDocumentAdd: Event<IModel[]> = this._onDocumentAdd.event;
	readonly onDocumentRemove: Event<string[]> = this._onDocumentRemove.event;

	constructor(
		extHostContext: IExtHostContext,
		@IModelService private _modelService: IModelService,
		@ITextFileService private _textFileService: ITextFileService,
		@IWorkbenchEditorService private _workbenchEditorService: IWorkbenchEditorService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IModeService modeService: IModeService,
		@IFileService fileService: IFileService,
		@ITextModelService textModelResolverService: ITextModelService,
		@IUntitledEditorService untitledEditorService: IUntitledEditorService,
		@IEditorGroupService editorGroupService: IEditorGroupService,
		@ITelemetryService telemetryService: ITelemetryService
	) {
		this._proxy = extHostContext.get(ExtHostContext.ExtHostDocumentsAndEditors);

		const mainThreadDocuments = new MainThreadDocuments(this, extHostContext, this._modelService, modeService, this._textFileService, fileService, textModelResolverService, untitledEditorService);
		extHostContext.set(MainContext.MainThreadDocuments, mainThreadDocuments);

		const mainThreadEditors = new MainThreadEditors(this, extHostContext, codeEditorService, this._workbenchEditorService, editorGroupService, telemetryService, textModelResolverService, fileService, this._modelService);
		extHostContext.set(MainContext.MainThreadEditors, mainThreadEditors);

		// It is expected that the ctor of the state computer calls our `_onDelta`.
		this._stateComputer = new MainThreadDocumentAndEditorStateComputer(delta => this._onDelta(delta), _modelService, codeEditorService, _workbenchEditorService);

		this._toDispose = [
			mainThreadDocuments,
			mainThreadEditors,
			this._stateComputer,
			this._onTextEditorAdd,
			this._onTextEditorRemove,
			this._onDocumentAdd,
			this._onDocumentRemove,
		];
	}

	dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	private _onDelta(delta: DocumentAndEditorStateDelta): void {

		let removedDocuments: string[];
		let removedEditors: string[] = [];
		let addedEditors: MainThreadTextEditor[] = [];

		// removed models
		removedDocuments = delta.removedDocuments.map(m => m.uri.toString());

		// added editors
		for (const apiEditor of delta.addedEditors) {
			const mainThreadEditor = new MainThreadTextEditor(apiEditor.id, apiEditor.document,
				apiEditor.editor, { onGainedFocus() { }, onLostFocus() { } }, this._modelService);

			this._editors[apiEditor.id] = mainThreadEditor;
			addedEditors.push(mainThreadEditor);
		}

		// removed editors
		for (const { id } of delta.removedEditors) {
			const mainThreadEditor = this._editors[id];
			if (mainThreadEditor) {
				mainThreadEditor.dispose();
				delete this._editors[id];
				removedEditors.push(id);
			}
		}

		let extHostDelta: IDocumentsAndEditorsDelta = Object.create(null);
		let empty = true;
		if (delta.newActiveEditor !== undefined) {
			empty = false;
			extHostDelta.newActiveEditor = delta.newActiveEditor;
		}
		if (removedDocuments.length > 0) {
			empty = false;
			extHostDelta.removedDocuments = removedDocuments;
		}
		if (removedEditors.length > 0) {
			empty = false;
			extHostDelta.removedEditors = removedEditors;
		}
		if (delta.addedDocuments.length > 0) {
			empty = false;
			extHostDelta.addedDocuments = delta.addedDocuments.map(m => this._toModelAddData(m));
		}
		if (delta.addedEditors.length > 0) {
			empty = false;
			extHostDelta.addedEditors = addedEditors.map(e => this._toTextEditorAddData(e));
		}

		if (!empty) {
			// first update ext host
			this._proxy.$acceptDocumentsAndEditorsDelta(extHostDelta);
			// second update dependent state listener
			this._onDocumentRemove.fire(removedDocuments);
			this._onDocumentAdd.fire(delta.addedDocuments);
			this._onTextEditorRemove.fire(removedEditors);
			this._onTextEditorAdd.fire(addedEditors);
		}
	}

	private _toModelAddData(model: IModel): IModelAddedData {
		return {
			url: model.uri,
			versionId: model.getVersionId(),
			lines: model.getLinesContent(),
			EOL: model.getEOL(),
			modeId: model.getLanguageIdentifier().language,
			isDirty: this._textFileService.isDirty(model.uri)
		};
	}

	private _toTextEditorAddData(textEditor: MainThreadTextEditor): ITextEditorAddData {
		return {
			id: textEditor.getId(),
			document: textEditor.getModel().uri,
			options: textEditor.getConfiguration(),
			selections: textEditor.getSelections(),
			editorPosition: this._findEditorPosition(textEditor)
		};
	}

	private _findEditorPosition(editor: MainThreadTextEditor): EditorPosition {
		for (let workbenchEditor of this._workbenchEditorService.getVisibleEditors()) {
			if (editor.matches(workbenchEditor)) {
				return workbenchEditor.position;
			}
		}
		return undefined;
	}

	findTextEditorIdFor(editor: IEditor): string {
		for (let id in this._editors) {
			if (this._editors[id].matches(editor)) {
				return id;
			}
		}
		return undefined;
	}

	getEditor(id: string): MainThreadTextEditor {
		return this._editors[id];
	}
}

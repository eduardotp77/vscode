/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import nls = require('vs/nls');
import errors = require('vs/base/common/errors');
import { toErrorMessage } from 'vs/base/common/errorMessage';
import paths = require('vs/base/common/paths');
import { Action } from 'vs/base/common/actions';
import URI from 'vs/base/common/uri';
import { FileOperationError, FileOperationResult } from 'vs/platform/files/common/files';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ITextFileService, ISaveErrorHandler, ITextFileEditorModel } from 'vs/workbench/services/textfile/common/textfiles';
import { ServicesAccessor, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { TextFileEditorModel } from 'vs/workbench/services/textfile/common/textFileEditorModel';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { ResourceMap } from 'vs/base/common/map';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { ResourceEditorInput } from 'vs/workbench/common/editor/resourceEditorInput';
import { IContextKeyService, IContextKey, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { FileOnDiskContentProvider } from 'vs/workbench/parts/files/common/files';
import { FileEditorInput } from 'vs/workbench/parts/files/common/editors/fileEditorInput';
import { IModelService } from 'vs/editor/common/services/modelService';
import { SAVE_FILE_COMMAND_ID, REVERT_FILE_COMMAND_ID, SAVE_FILE_AS_COMMAND_ID, SAVE_FILE_AS_LABEL } from 'vs/workbench/parts/files/electron-browser/fileCommands';
import { createTextBufferFactoryFromSnapshot } from 'vs/editor/common/model/textModel';
import { INotificationService, INotificationHandle, INotificationActions, Severity } from 'vs/platform/notification/common/notification';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ExecuteCommandAction } from 'vs/platform/actions/common/actions';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';

export const CONFLICT_RESOLUTION_CONTEXT = 'saveConflictResolutionContext';
export const CONFLICT_RESOLUTION_SCHEME = 'conflictResolution';

const LEARN_MORE_DIRTY_WRITE_IGNORE_KEY = 'learnMoreDirtyWriteError';

const conflictEditorHelp = nls.localize('userGuide', "Use the actions in the editor tool bar to either undo your changes or overwrite the content on disk with your changes.");

// A handler for save error happening with conflict resolution actions
export class SaveErrorHandler implements ISaveErrorHandler, IWorkbenchContribution {
	private messages: ResourceMap<INotificationHandle>;
	private toUnbind: IDisposable[];
	private conflictResolutionContext: IContextKey<boolean>;
	private activeConflictResolutionResource: URI;

	constructor(
		@INotificationService private notificationService: INotificationService,
		@ITextFileService private textFileService: ITextFileService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@ITextModelService textModelService: ITextModelService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IStorageService private storageService: IStorageService
	) {
		this.toUnbind = [];
		this.messages = new ResourceMap<INotificationHandle>();
		this.conflictResolutionContext = new RawContextKey<boolean>(CONFLICT_RESOLUTION_CONTEXT, false).bindTo(contextKeyService);

		const provider = instantiationService.createInstance(FileOnDiskContentProvider);
		this.toUnbind.push(provider);

		const registrationDisposal = textModelService.registerTextModelContentProvider(CONFLICT_RESOLUTION_SCHEME, provider);
		this.toUnbind.push(registrationDisposal);

		// Hook into model
		TextFileEditorModel.setSaveErrorHandler(this);

		this.registerListeners();
	}

	private registerListeners(): void {
		this.toUnbind.push(this.textFileService.models.onModelSaved(e => this.onFileSavedOrReverted(e.resource)));
		this.toUnbind.push(this.textFileService.models.onModelReverted(e => this.onFileSavedOrReverted(e.resource)));
		this.toUnbind.push(this.editorGroupService.onEditorsChanged(() => this.onEditorsChanged()));
	}

	private onEditorsChanged(): void {
		let isActiveEditorSaveConflictResolution = false;
		let activeConflictResolutionResource: URI;

		const activeEditor = this.editorService.getActiveEditor();
		if (activeEditor && activeEditor.input instanceof DiffEditorInput && activeEditor.input.originalInput instanceof ResourceEditorInput && activeEditor.input.modifiedInput instanceof FileEditorInput) {
			const resource = activeEditor.input.originalInput.getResource();
			if (resource && resource.scheme === CONFLICT_RESOLUTION_SCHEME) {
				isActiveEditorSaveConflictResolution = true;
				activeConflictResolutionResource = activeEditor.input.modifiedInput.getResource();
			}
		}

		this.conflictResolutionContext.set(isActiveEditorSaveConflictResolution);
		this.activeConflictResolutionResource = activeConflictResolutionResource;
	}

	private onFileSavedOrReverted(resource: URI): void {
		const messageHandle = this.messages.get(resource);
		if (messageHandle) {
			messageHandle.dispose();
			this.messages.delete(resource);
		}
	}

	public onSaveError(error: any, model: ITextFileEditorModel): void {
		const fileOperationError = error as FileOperationError;
		const resource = model.getResource();

		let message: string;
		const actions: INotificationActions = { primary: [], secondary: [] };

		// Dirty write prevention
		if (fileOperationError.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE) {

			// If the user tried to save from the opened conflict editor, show its message again
			if (this.activeConflictResolutionResource && this.activeConflictResolutionResource.toString() === model.getResource().toString()) {
				if (this.storageService.getBoolean(LEARN_MORE_DIRTY_WRITE_IGNORE_KEY)) {
					return; // return if this message is ignored
				}

				message = conflictEditorHelp;

				actions.primary.push(this.instantiationService.createInstance(ResolveConflictLearnMoreAction));
				actions.secondary.push(this.instantiationService.createInstance(DoNotShowResolveConflictLearnMoreAction));
			}

			// Otherwise show the message that will lead the user into the save conflict editor.
			else {
				message = nls.localize('staleSaveError', "Failed to save '{0}': The content on disk is newer. Please compare your version with the one on disk.", paths.basename(resource.fsPath));

				actions.primary.push(this.instantiationService.createInstance(ResolveSaveConflictAction, model));
			}
		}

		// Any other save error
		else {
			const isReadonly = fileOperationError.fileOperationResult === FileOperationResult.FILE_READ_ONLY;
			const triedToMakeWriteable = isReadonly && fileOperationError.options && fileOperationError.options.overwriteReadonly;
			const isPermissionDenied = fileOperationError.fileOperationResult === FileOperationResult.FILE_PERMISSION_DENIED;

			// Save Elevated
			if (isPermissionDenied || triedToMakeWriteable) {
				actions.primary.push(this.instantiationService.createInstance(SaveElevatedAction, model, triedToMakeWriteable));
			}

			// Overwrite
			else if (isReadonly) {
				actions.primary.push(this.instantiationService.createInstance(OverwriteReadonlyAction, model));
			}

			// Retry
			else {
				actions.primary.push(this.instantiationService.createInstance(ExecuteCommandAction, SAVE_FILE_COMMAND_ID, nls.localize('retry', "Retry")));
			}

			// Save As
			actions.primary.push(this.instantiationService.createInstance(ExecuteCommandAction, SAVE_FILE_AS_COMMAND_ID, SAVE_FILE_AS_LABEL));

			// Discard
			actions.primary.push(this.instantiationService.createInstance(ExecuteCommandAction, REVERT_FILE_COMMAND_ID, nls.localize('discard', "Discard")));

			if (isReadonly) {
				if (triedToMakeWriteable) {
					message = nls.localize('readonlySaveErrorAdmin', "Failed to save '{0}': File is write protected. Select 'Overwrite as Admin' to retry as administrator.", paths.basename(resource.fsPath));
				} else {
					message = nls.localize('readonlySaveError', "Failed to save '{0}': File is write protected. Select 'Overwrite' to attempt to remove protection.", paths.basename(resource.fsPath));
				}
			} else if (isPermissionDenied) {
				message = nls.localize('permissionDeniedSaveError', "Failed to save '{0}': Insufficient permissions. Select 'Retry as Admin' to retry as administrator.", paths.basename(resource.fsPath));
			} else {
				message = nls.localize('genericSaveError', "Failed to save '{0}': {1}", paths.basename(resource.fsPath), toErrorMessage(error, false));
			}
		}

		// Show message and keep function to hide in case the file gets saved/reverted
		this.messages.set(model.getResource(), this.notificationService.notify({ severity: Severity.Error, message, actions }));
	}

	public dispose(): void {
		this.toUnbind = dispose(this.toUnbind);

		this.messages.clear();
	}
}

const pendingResolveSaveConflictMessages: INotificationHandle[] = [];
function clearPendingResolveSaveConflictMessages(): void {
	while (pendingResolveSaveConflictMessages.length > 0) {
		pendingResolveSaveConflictMessages.pop().dispose();
	}
}

class ResolveConflictLearnMoreAction extends Action {

	constructor(
		@IOpenerService private openerService: IOpenerService
	) {
		super('workbench.files.action.resolveConflictLearnMore', nls.localize('learnMore', "Learn More"));
	}

	public run(): TPromise<any> {
		return this.openerService.open(URI.parse('https://go.microsoft.com/fwlink/?linkid=868264'));
	}
}

class DoNotShowResolveConflictLearnMoreAction extends Action {

	constructor(
		@IStorageService private storageService: IStorageService
	) {
		super('workbench.files.action.resolveConflictLearnMoreDoNotShowAgain', nls.localize('dontShowAgain', "Don't Show Again"));
	}

	public run(notification: IDisposable): TPromise<any> {
		this.storageService.store(LEARN_MORE_DIRTY_WRITE_IGNORE_KEY, true);

		// Hide notification
		notification.dispose();

		return TPromise.as(void 0);
	}
}

class ResolveSaveConflictAction extends Action {

	constructor(
		private model: ITextFileEditorModel,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@INotificationService private notificationService: INotificationService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IStorageService private storageService: IStorageService,
		@IEnvironmentService private environmentService: IEnvironmentService
	) {
		super('workbench.files.action.resolveConflict', nls.localize('compareChanges', "Compare"));
	}

	public run(): TPromise<any> {
		if (!this.model.isDisposed()) {
			const resource = this.model.getResource();
			const name = paths.basename(resource.fsPath);
			const editorLabel = nls.localize('saveConflictDiffLabel', "{0} (on disk) ↔ {1} (in {2}) - Resolve save conflict", name, name, this.environmentService.appNameLong);

			return this.editorService.openEditor(
				{
					leftResource: URI.from({ scheme: CONFLICT_RESOLUTION_SCHEME, path: resource.fsPath }),
					rightResource: resource,
					label: editorLabel,
					options: { pinned: true }
				}
			).then(() => {
				if (this.storageService.getBoolean(LEARN_MORE_DIRTY_WRITE_IGNORE_KEY)) {
					return; // return if this message is ignored
				}

				// Show additional help how to resolve the save conflict
				const actions: INotificationActions = { primary: [], secondary: [] };
				actions.primary.push(this.instantiationService.createInstance(ResolveConflictLearnMoreAction));
				actions.secondary.push(this.instantiationService.createInstance(DoNotShowResolveConflictLearnMoreAction));

				const handle = this.notificationService.notify({ severity: Severity.Info, message: conflictEditorHelp, actions });
				pendingResolveSaveConflictMessages.push(handle);
			});
		}

		return TPromise.as(true);
	}
}

class SaveElevatedAction extends Action {

	constructor(
		private model: ITextFileEditorModel,
		private triedToMakeWriteable: boolean
	) {
		super('workbench.files.action.saveElevated', triedToMakeWriteable ? nls.localize('overwriteElevated', "Overwrite as Admin...") : nls.localize('saveElevated', "Retry as Admin..."));
	}

	public run(): TPromise<any> {
		if (!this.model.isDisposed()) {
			this.model.save({
				writeElevated: true,
				overwriteReadonly: this.triedToMakeWriteable
			}).done(null, errors.onUnexpectedError);
		}

		return TPromise.as(true);
	}
}

class OverwriteReadonlyAction extends Action {

	constructor(
		private model: ITextFileEditorModel
	) {
		super('workbench.files.action.overwrite', nls.localize('overwrite', "Overwrite"));
	}

	public run(): TPromise<any> {
		if (!this.model.isDisposed()) {
			this.model.save({ overwriteReadonly: true }).done(null, errors.onUnexpectedError);
		}

		return TPromise.as(true);
	}
}

export const acceptLocalChangesCommand = (accessor: ServicesAccessor, resource: URI) => {
	const editorService = accessor.get(IWorkbenchEditorService);
	const resolverService = accessor.get(ITextModelService);
	const modelService = accessor.get(IModelService);

	const editor = editorService.getActiveEditor();
	const input = editor.input;
	const position = editor.position;

	resolverService.createModelReference(resource).then(reference => {
		const model = reference.object as ITextFileEditorModel;
		const localModelSnapshot = model.createSnapshot();

		clearPendingResolveSaveConflictMessages(); // hide any previously shown message about how to use these actions

		// Revert to be able to save
		return model.revert().then(() => {

			// Restore user value (without loosing undo stack)
			modelService.updateModel(model.textEditorModel, createTextBufferFactoryFromSnapshot(localModelSnapshot));

			// Trigger save
			return model.save().then(() => {

				// Reopen file input
				return editorService.openEditor({ resource: model.getResource() }, position).then(() => {

					// Clean up
					input.dispose();
					reference.dispose();
					editorService.closeEditor(position, input);
				});
			});
		});
	});
};

export const revertLocalChangesCommand = (accessor: ServicesAccessor, resource: URI) => {
	const editorService = accessor.get(IWorkbenchEditorService);
	const resolverService = accessor.get(ITextModelService);

	const editor = editorService.getActiveEditor();
	const input = editor.input;
	const position = editor.position;

	resolverService.createModelReference(resource).then(reference => {
		const model = reference.object as ITextFileEditorModel;

		clearPendingResolveSaveConflictMessages(); // hide any previously shown message about how to use these actions

		// Revert on model
		return model.revert().then(() => {

			// Reopen file input
			return editorService.openEditor({ resource: model.getResource() }, position).then(() => {

				// Clean up
				input.dispose();
				reference.dispose();
				editorService.closeEditor(position, input);
			});
		});
	});
};

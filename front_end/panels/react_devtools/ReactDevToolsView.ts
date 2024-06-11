// Copyright (c) Meta Platforms, Inc. and affiliates.
// Copyright 2024 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as i18n from '../../core/i18n/i18n.js';
import * as UI from '../../ui/legacy/legacy.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as ReactDevTools from '../../third_party/react-devtools/react-devtools.js';

import type * as ReactDevToolsTypes from '../../third_party/react-devtools/react-devtools.js';
import * as Common from '../../core/common/common.js';
import * as Workspace from '../../models/workspace/workspace.js';

import {
  Events as ReactDevToolsModelEvents,
  ReactDevToolsModel,
  type EventTypes as ReactDevToolsModelEventTypes,
} from './ReactDevToolsModel.js';
import * as Bindings from '../../models/bindings/bindings.js';
import * as Logs from '../../models/logs/logs.js';
import type * as Platform from '../../core/platform/platform.js';

const UIStrings = {
  /**
   *@description Title of the React DevTools view
   */
  title: 'React DevTools',
};
const str_ = i18n.i18n.registerUIStrings('panels/react_devtools/ReactDevToolsView.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

type ReactDevToolsInitializedEvent = Common.EventTarget.EventTargetEvent<ReactDevToolsModelEventTypes[ReactDevToolsModelEvents.Initialized]>;
type ReactDevToolsMessageReceivedEvent = Common.EventTarget.EventTargetEvent<ReactDevToolsModelEventTypes[ReactDevToolsModelEvents.MessageReceived]>;

export class ReactDevToolsViewImpl extends UI.View.SimpleView {
  private readonly wall: ReactDevToolsTypes.Wall;
  private bridge: ReactDevToolsTypes.Bridge | null = null;
  private store: ReactDevToolsTypes.Store | null = null;
  private executionContext: SDK.RuntimeModel.ExecutionContext | null = null;
  private readonly listeners: Set<ReactDevToolsTypes.WallListener> = new Set();

  constructor() {
    super(i18nString(UIStrings.title));

    this.wall = {
      listen: (listener): Function => {
        this.listeners.add(listener);

        return (): void => {
          this.listeners.delete(listener);
        };
      },
      send: (event, payload): void => this.sendMessage(event, payload),
    };

    // Notify backend if Chrome DevTools was closed, marking frontend as disconnected
    window.addEventListener('beforeunload', () => this.bridge?.shutdown());

    SDK.TargetManager.TargetManager.instance().addModelListener(
      ReactDevToolsModel,
      ReactDevToolsModelEvents.Initialized,
      this.onInitialized,
      this,
    );
    SDK.TargetManager.TargetManager.instance().addModelListener(
      ReactDevToolsModel,
      ReactDevToolsModelEvents.Destroyed,
      this.onDestroyed,
      this,
    );
    SDK.TargetManager.TargetManager.instance().addModelListener(
      ReactDevToolsModel,
      ReactDevToolsModelEvents.MessageReceived,
      this.onMessage,
      this,
    );

    this.renderLoader();
  }

  private onInitialized({data: executionContext}: ReactDevToolsInitializedEvent): void {
    this.clearLoader();

    this.executionContext = executionContext;
    this.bridge = ReactDevTools.createBridge(this.wall);
    this.store = ReactDevTools.createStore(this.bridge);

    const usingDarkTheme = window.matchMedia('(prefers-color-scheme: dark)').matches;
    ReactDevTools.initialize(this.contentElement, {
      bridge: this.bridge,
      store: this.store,
      theme: usingDarkTheme ? 'dark' : 'light',
      canViewElementSourceFunction: () => true,
      viewElementSourceFunction: this.viewElementSourceFunction.bind(this),
      viewAttributeSourceFunction: this.viewAttributeSourceFunction.bind(this),
    });
  }

  private onDestroyed(): void {
    // Unmount React DevTools view
    this.contentElement.removeChildren();

    this.executionContext = null;
    this.bridge?.shutdown();
    this.bridge = null;
    this.store = null;
    this.listeners.clear();

    this.renderLoader();
  }

  // Based on ExtensionServer.onOpenResource
  private async openResource(
    url: Platform.DevToolsPath.UrlString,
    lineNumber: number, // 0-based
    columnNumber: number, // 0-based
  ): Promise<void> {
    const uiSourceCode = Workspace.Workspace.WorkspaceImpl.instance().uiSourceCodeForURL(url);
    if (uiSourceCode) {
      // Unlike the Extension API's version of openResource, we want to normalize the location
      // so that source maps (if any) are applied.
      const normalizedUiLocation = await Bindings.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance().normalizeUILocation(uiSourceCode.uiLocation(lineNumber, columnNumber));
      void Common.Revealer.reveal(normalizedUiLocation);
      return;
    }

    const resource = Bindings.ResourceUtils.resourceForURL(url);
    if (resource) {
      void Common.Revealer.reveal(resource);
      return;
    }

    const request = Logs.NetworkLog.NetworkLog.instance().requestForURL(url);
    if (request) {
      void Common.Revealer.reveal(request);
      return;
    }

    throw new Error('Could not find resource for ' + url);
  }

  private viewElementSourceFunction(source: ReactDevToolsTypes.Source, symbolicatedSource: ReactDevToolsTypes.Source | null): void {
    const {sourceURL, line, column} = symbolicatedSource
      ? symbolicatedSource
      : source;

    // We use 1-based line and column, Chrome expects them 0-based.
    void this.openResource(sourceURL as Platform.DevToolsPath.UrlString, line - 1, column - 1);
  }

  private viewAttributeSourceFunction(id: number, path: Array<string | number>): void {
    // @ts-ignore
    const rendererID = this.store.getRendererIDForElement(id);
    if (rendererID == null) {
      return
    }

    // Ask the renderer interface to find the specified attribute,
    // and store it as a global variable on the window.
    // @ts-ignore
    this.bridge.send('viewAttributeSource', {id, path, rendererID});

    setTimeout(() => {
      const expression = `
        if (window.$attribute != null) {
          inspect(window.$attribute);
        }
      `;

      this.executionContext?.evaluate(
        {
          expression,
          objectGroup: 'console',
          includeCommandLineAPI: true,
        },
        /* userGesture */ false,
        /* awaitPromise */ false
      );
    }, 100);
  }

  private renderLoader(): void {
    const loaderContainer = document.createElement('div');
    loaderContainer.setAttribute('style', 'display: flex; flex: 1; justify-content: center; align-items: center');

    const loader = document.createElement('span');
    loader.classList.add('spinner');

    loaderContainer.appendChild(loader);
    this.contentElement.appendChild(loaderContainer);
  }

  private clearLoader(): void {
    this.contentElement.removeChildren();
  }

  override wasShown(): void {
    super.wasShown();

    // This has to be here, because initialize() can be called when user is on the other panel and view is unmounted
    this.registerCSSFiles([ReactDevTools.CSS]);
  }

  private onMessage({data: message}: ReactDevToolsMessageReceivedEvent): void {
    if (!message) {
      return;
    }

    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private sendMessage(event: string, payload?: ReactDevToolsTypes.MessagePayload): void {
    for (const model of SDK.TargetManager.TargetManager.instance().models(ReactDevToolsModel, {scoped: true})) {
      void model.sendMessage({event, payload});
    }
  }
}

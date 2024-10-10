// Copyright (c) Meta Platforms, Inc. and affiliates.
// Copyright 2024 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as SDK from '../../core/sdk/sdk.js';
import * as ReactNativeModels from '../../models/react_native/react_native.js';
import * as ReactDevTools from '../../third_party/react-devtools/react-devtools.js';

import type * as ReactDevToolsTypes from '../../third_party/react-devtools/react-devtools.js';
import type * as Common from '../../core/common/common.js';

export const enum Events {
  InitializationCompleted = 'InitializationCompleted',
  InitializationFailed = 'InitializationFailed',
  Destroyed = 'Destroyed',
}

export type EventTypes = {
  [Events.InitializationCompleted]: void,
  [Events.InitializationFailed]: string,
  [Events.Destroyed]: void,
};

type ReactDevToolsBindingsBackendExecutionContextUnavailableEvent = Common.EventTarget.EventTargetEvent<
  ReactNativeModels.ReactDevToolsBindingsModel.EventTypes[
    ReactNativeModels.ReactDevToolsBindingsModel.Events.BackendExecutionContextUnavailable
  ]
>;

export class ReactDevToolsModel extends SDK.SDKModel.SDKModel<EventTypes> {
  private static readonly FUSEBOX_BINDING_NAMESPACE = 'react-devtools';

  readonly #wall: ReactDevToolsTypes.Wall;
  readonly #bindingsModel: ReactNativeModels.ReactDevToolsBindingsModel.ReactDevToolsBindingsModel;
  readonly #listeners: Set<ReactDevToolsTypes.WallListener> = new Set();
  #initializeCalled: boolean = false;
  #initialized: boolean = false;
  #bridge: ReactDevToolsTypes.Bridge | null = null;
  #store: ReactDevToolsTypes.Store | null = null;

  constructor(target: SDK.Target.Target) {
    super(target);

    this.#wall = {
      listen: (listener): Function => {
        this.#listeners.add(listener);

        return (): void => {
          this.#listeners.delete(listener);
        };
      },
      send: (event, payload): void => void this.#sendMessage({event, payload}),
    };

    const bindingsModel = target.model(ReactNativeModels.ReactDevToolsBindingsModel.ReactDevToolsBindingsModel);
    if (bindingsModel === null) {
      throw new Error('Failed to construct ReactDevToolsModel: ReactDevToolsBindingsModel was null');
    }

    this.#bindingsModel = bindingsModel;

    bindingsModel.addEventListener(
      ReactNativeModels.ReactDevToolsBindingsModel.Events.BackendExecutionContextCreated,
      this.#handleBackendExecutionContextCreated,
      this,
    );
    bindingsModel.addEventListener(
      ReactNativeModels.ReactDevToolsBindingsModel.Events.BackendExecutionContextUnavailable,
      this.#handleBackendExecutionContextUnavailable,
      this,
    );
    bindingsModel.addEventListener(
      ReactNativeModels.ReactDevToolsBindingsModel.Events.BackendExecutionContextDestroyed,
      this.#handleBackendExecutionContextDestroyed,
      this,
    );

    // Notify backend if Chrome DevTools was closed, marking frontend as disconnected
    window.addEventListener('beforeunload', () => this.#bridge?.shutdown());
  }

  ensureInitialized(): void {
    if (this.#initializeCalled) {
      return;
    }

    this.#initializeCalled = true;
    void this.#initialize();
  }

  async #initialize(): Promise<void> {
    try {
      const bindingsModel = this.#bindingsModel;
      await bindingsModel.enable();

      bindingsModel.subscribeToDomainMessages(
        ReactDevToolsModel.FUSEBOX_BINDING_NAMESPACE,
          message => this.#handleMessage(message as ReactDevToolsTypes.Message),
      );

      await bindingsModel.initializeDomain(ReactDevToolsModel.FUSEBOX_BINDING_NAMESPACE);

      this.#initialized = true;
      this.#finishInitializationAndNotify();
    } catch (e) {
      this.dispatchEventToListeners(Events.InitializationFailed, e.message);
    }
  }

  isInitialized(): boolean {
    return this.#initialized;
  }

  getBridgeOrThrow(): ReactDevToolsTypes.Bridge {
    if (this.#bridge === null) {
      throw new Error('Failed to get bridge from ReactDevToolsModel: bridge was null');
    }

    return this.#bridge;
  }

  getStoreOrThrow(): ReactDevToolsTypes.Store {
    if (this.#store === null) {
      throw new Error('Failed to get store from ReactDevToolsModel: store was null');
    }

    return this.#store;
  }

  #handleMessage(message: ReactDevToolsTypes.Message): void {
    if (!message) {
      return;
    }

    for (const listener of this.#listeners) {
      listener(message);
    }
  }

  async #sendMessage(message: ReactDevToolsTypes.Message): Promise<void> {
    const rdtBindingsModel = this.#bindingsModel;
    if (!rdtBindingsModel) {
      throw new Error('Failed to send message from ReactDevToolsModel: ReactDevToolsBindingsModel was null');
    }

    return rdtBindingsModel.sendMessage(ReactDevToolsModel.FUSEBOX_BINDING_NAMESPACE, message);
  }

  #handleBackendExecutionContextCreated(): void {
    const rdtBindingsModel = this.#bindingsModel;
    if (!rdtBindingsModel) {
      throw new Error('ReactDevToolsModel failed to handle BackendExecutionContextCreated event: ReactDevToolsBindingsModel was null');
    }

    // This could happen if the app was reloaded while ReactDevToolsBindingsModel was initializing
    if (!rdtBindingsModel.isEnabled()) {
      this.ensureInitialized();
    } else {
      this.#finishInitializationAndNotify();
    }
  }

  #finishInitializationAndNotify(): void {
    this.#bridge = ReactDevTools.createBridge(this.#wall);
    this.#store = ReactDevTools.createStore(this.#bridge, {
      supportsReloadAndProfile: true,
    });
    this.#attachReloadToProfileListener();
    this.dispatchEventToListeners(Events.InitializationCompleted);
  }

  #attachReloadToProfileListener(): void {
    this.#wall.listen((message: ReactDevToolsTypes.Message): void => {
      if (message.event === 'reloadAppForProfiling') {
        SDK.ResourceTreeModel.ResourceTreeModel.reloadAllPages(false);
      }
    });
  }

  #handleBackendExecutionContextUnavailable({data: errorMessage}: ReactDevToolsBindingsBackendExecutionContextUnavailableEvent): void {
    this.dispatchEventToListeners(Events.InitializationFailed, errorMessage);
  }

  #handleBackendExecutionContextDestroyed(): void {
    this.#bridge?.shutdown();
    this.#bridge = null;
    this.#store = null;
    this.#listeners.clear();

    this.dispatchEventToListeners(Events.Destroyed);
  }
}

SDK.SDKModel.SDKModel.register(ReactDevToolsModel, {capabilities: SDK.Target.Capability.JS, autostart: false});

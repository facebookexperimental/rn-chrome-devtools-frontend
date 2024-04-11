// Copyright (c) Meta Platforms, Inc. and affiliates.
// Copyright 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

export type RNReliabilityEventListener = (event: ReactNativeChromeDevToolsEvent) => void;

let instance: RNPerfMetrics|null = null;

export function getInstance(): RNPerfMetrics {
  if (instance === null) {
    instance = new RNPerfMetrics();
  }
  return instance;
}

type UnsubscribeFn = () => void;
class RNPerfMetrics {
  #listeners: Set<RNReliabilityEventListener> = new Set();
  #launchId: string|null = null;

  addEventListener(listener: RNReliabilityEventListener): UnsubscribeFn {
    this.#listeners.add(listener);

    const unsubscribe = (): void => {
      this.#listeners.delete(listener);
    };

    return unsubscribe;
  }

  removeAllEventListeners(): void {
    this.#listeners.clear();
  }

  sendEvent(event: ReactNativeChromeDevToolsEvent): void {
    if (globalThis.enableReactNativePerfMetrics !== true) {
      return;
    }

    const errors = [];
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (e) {
        errors.push(e);
      }
    }

    if (errors.length > 0) {
      const error = new AggregateError(errors);
      console.error('Error occurred when calling event listeners', error);
    }
  }

  setLaunchId(launchId: string|null): void {
    this.#launchId = launchId;
  }

  entryPointLoadingStarted(entryPoint: EntryPoint): void {
    this.sendEvent({
      eventName: 'Entrypoint.LoadingStarted',
      timestamp: getPerfTimestamp(),
      launchId: this.#launchId,
      entryPoint,
    });
  }

  entryPointLoadingFinished(entryPoint: EntryPoint): void {
    this.sendEvent({
      eventName: 'Entrypoint.LoadingFinished',
      timestamp: getPerfTimestamp(),
      launchId: this.#launchId,
      entryPoint,
    });
  }
}

function getPerfTimestamp(): DOMHighResTimeStamp {
  return performance.timeOrigin + performance.now();
}

export function registerPerfMetricsGlobalPostMessageHandler(): void {
  if (globalThis.enableReactNativePerfMetrics !== true ||
      globalThis.enableReactNativePerfMetricsGlobalPostMessage !== true) {
    return;
  }

  getInstance().addEventListener(event => {
    window.postMessage({event, tag: 'react-native-chrome-devtools-perf-metrics'}, window.location.origin);
  });
}

type CommonEventFields = Readonly<{
  timestamp: DOMHighResTimeStamp,
  launchId: string | void | null,
}>;

type EntryPoint = 'rn_fusebox'|'rn_inspector';

export type EntrypointLoadingStartedEvent = Readonly<CommonEventFields&{
  eventName: 'Entrypoint.LoadingStarted',
  entryPoint: EntryPoint,
}>;

export type EntrypointLoadingFinishedEvent = Readonly<CommonEventFields&{
  eventName: 'Entrypoint.LoadingFinished',
  entryPoint: EntryPoint,
}>;

export type DebuggerReadyEvent = Readonly<CommonEventFields&{
  eventName: 'Debugger.IsReadyToPause',
}>;

export type ReactNativeChromeDevToolsEvent =
    EntrypointLoadingStartedEvent|EntrypointLoadingFinishedEvent|DebuggerReadyEvent;

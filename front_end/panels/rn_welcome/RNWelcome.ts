// Copyright (c) Meta Platforms, Inc. and affiliates.
// Copyright 2024 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type * as Common from '../../core/common/common.js';
import * as UI from '../../ui/legacy/legacy.js';
import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as SDK from '../../core/sdk/sdk.js';

import rnWelcomeStyles from './rnWelcome.css.js';
import * as LitHtml from '../../ui/lit-html/lit-html.js';
import type * as Platform from '../../core/platform/platform.js';
import type * as Protocol from '../../generated/protocol.js';

const UIStrings = {
  /** @description Beta label */
  betaLabel: 'Beta',
  /** @description Tech Preview label */
  techPreviewLabel: 'Tech Preview',
  /** @description Welcome text */
  welcomeMessage: 'Welcome to debugging in React Native',
  /** @description "Debugging docs" link */
  docsLabel: 'Debugging docs',
  /** @description "What's new" link */
  whatsNewLabel: "What's new",
  /** @description "Debugging Basics" title (docs item 1) */
  docsDebuggingBasics: 'Debugging Basics',
  /** @description "Debugging Basics" item detail */
  docsDebuggingBasicsDetail: 'Overview of debugging tools in React Native',
  /** @description "React Native DevTools" title (docs item 2) */
  docsReactNativeDevTools: 'React Native DevTools',
  /** @description "React Native DevTools" item detail */
  docsReactDevToolsDetail: 'Explore features available in React Native DevTools',
  /** @description "Native Debugging" title (docs item 3) */
  docsNativeDebugging: 'Native Debugging',
  /** @description "Native Debugging" item detail */
  docsNativeDebuggingDetail: 'Find out more about native debugging tools',
};
const {render, html} = LitHtml;

const str_ = i18n.i18n.registerUIStrings('panels/rn_welcome/RNWelcome.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

let rnWelcomeImplInstance: RNWelcomeImpl;

type RNWelcomeOptions = {
  debuggerBrandName: () => Platform.UIString.LocalizedString,
  showBetaLabel?: boolean,
  showTechPreviewLabel?: boolean,
  showDocs?: boolean,
};

export class RNWelcomeImpl extends UI.Widget.VBox implements
    SDK.TargetManager.SDKModelObserver<SDK.ReactNativeApplicationModel.ReactNativeApplicationModel> {
  private readonly options: RNWelcomeOptions;

  #reactNativeVersion: string|undefined;

  static instance(options: RNWelcomeOptions): RNWelcomeImpl {
    if (!rnWelcomeImplInstance) {
      rnWelcomeImplInstance = new RNWelcomeImpl(options);
    }
    return rnWelcomeImplInstance;
  }

  private constructor(options: RNWelcomeOptions) {
    super(true, true);

    this.options = options;

    SDK.TargetManager.TargetManager.instance().observeModels(
        SDK.ReactNativeApplicationModel.ReactNativeApplicationModel, this);
  }

  override wasShown(): void {
    super.wasShown();
    this.registerCSSFiles([rnWelcomeStyles]);
    this.render();
    UI.InspectorView.InspectorView.instance().showDrawer({focus: true, hasTargetDrawer: false});
  }

  modelAdded(model: SDK.ReactNativeApplicationModel.ReactNativeApplicationModel): void {
    model.ensureEnabled();
    model.addEventListener(
        SDK.ReactNativeApplicationModel.Events.MetadataUpdated, this.#handleMetadataUpdated, this);
    this.#reactNativeVersion = model.metadataCached?.reactNativeVersion;
  }

  modelRemoved(model: SDK.ReactNativeApplicationModel.ReactNativeApplicationModel): void {
    model.removeEventListener(
        SDK.ReactNativeApplicationModel.Events.MetadataUpdated, this.#handleMetadataUpdated, this);
  }

  #handleMetadataUpdated(
      event: Common.EventTarget.EventTargetEvent<Protocol.ReactNativeApplication.MetadataUpdatedEvent>): void {
    this.#reactNativeVersion = event.data.reactNativeVersion;

    if (this.isShowing()) {
      this.render();
    }
  }

  #handleLinkPress(url: string): void {
    Host.InspectorFrontendHost.InspectorFrontendHostInstance.openInNewTab(
        url as Platform.DevToolsPath.UrlString,
    );
  }

  render(): void {
    const {
      debuggerBrandName,
      showBetaLabel = false,
      showTechPreviewLabel = false,
      showDocs = false,
    } = this.options;
    const welcomeIconUrl = new URL(
      '../../Images/react_native/welcomeIcon.png',
      import.meta.url,
    ).toString();
    const docsImage1Url = new URL(
      '../../Images/react_native/learn-debugging-basics.jpg',
      import.meta.url,
    ).toString();
    const docsImage2Url = new URL(
      '../../Images/react_native/learn-react-native-devtools.jpg',
      import.meta.url,
    ).toString();
    const docsImage3Url = new URL(
      '../../Images/react_native/learn-native-debugging.jpg',
      import.meta.url,
    ).toString();

    render(html`
      <div class="rn-welcome-panel">
        <header class="rn-welcome-hero">
          <div class="rn-welcome-heading">
            <img class="rn-welcome-icon" src=${welcomeIconUrl} role="presentation" />
            <h1 class="rn-welcome-title">
              ${debuggerBrandName()}
            </h1>
            ${showBetaLabel ? html`
              <div class="rn-welcome-title-accessory">
                ${i18nString(UIStrings.betaLabel)}
              </div>
            ` : null}
            ${showTechPreviewLabel ? html`
              <div class="rn-welcome-title-accessory rn-welcome-title-accessory-purple">
                ${i18nString(UIStrings.techPreviewLabel)}
              </div>
            ` : null}
          </div>
          <div class="rn-welcome-tagline">
            ${i18nString(UIStrings.welcomeMessage)}
          </div>
          <div class="rn-welcome-links">
            <x-link class="devtools-link" href="https://reactnative.dev/docs/debugging">
              ${i18nString(UIStrings.docsLabel)}
            </x-link>
            <x-link class="devtools-link" href="https://reactnative.dev/blog">
              ${i18nString(UIStrings.whatsNewLabel)}
            </x-link>
          </div>
          ${this.#reactNativeVersion !== null && this.#reactNativeVersion !== undefined ? html`
              <p class="rn-welcome-version">React Native: <code>${this.#reactNativeVersion}</code></p>
            ` : null}
        </header>
        ${showDocs ? html`
          <section class="rn-welcome-docsfeed">
            <h2 class="rn-welcome-h2">Learn</h2>
            <button class="rn-welcome-docsfeed-item" type="button" role="link" @click=${this.#handleLinkPress.bind(this, 'https:\/\/reactnative.dev/docs/debugging')} title=${i18nString(UIStrings.docsDebuggingBasics)}>
              <div class="rn-welcome-image" style="background-image: url('${docsImage1Url}')"></div>
              <div>
                <p class="devtools-link">${i18nString(UIStrings.docsDebuggingBasics)}</p>
                <p>${i18nString(UIStrings.docsDebuggingBasicsDetail)}</p>
              </div>
            </button>
            <button class="rn-welcome-docsfeed-item" type="button" role="link" @click=${this.#handleLinkPress.bind(this, 'https:\/\/reactnative.dev/docs/react-native-devtools')} title=${i18nString(UIStrings.docsReactNativeDevTools)}>
              <div class="rn-welcome-image" style="background-image: url('${docsImage2Url}')"></div>
              <div>
                <p class="devtools-link">${i18nString(UIStrings.docsReactNativeDevTools)}</p>
                <p>${i18nString(UIStrings.docsReactDevToolsDetail)}</p>
              </div>
            </button>
            <button class="rn-welcome-docsfeed-item" type="button" role="link" @click=${this.#handleLinkPress.bind(this, 'https:\/\/reactnative.dev/docs/debugging-native-code')} title=${i18nString(UIStrings.docsNativeDebugging)}>
              <div class="rn-welcome-image" style="background-image: url('${docsImage3Url}')"></div>
              <div>
                <p class="devtools-link">${i18nString(UIStrings.docsNativeDebugging)}</p>
                <p>${i18nString(UIStrings.docsNativeDebuggingDetail)}</p>
              </div>
            </button>
          </section>
        ` : null}
      </div>
    `, this.contentElement, {host: this});
  }
}

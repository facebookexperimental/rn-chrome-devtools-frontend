// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as TraceModel from '../../../../../front_end/models/trace/trace.js';

const {assert} = chai;

import {loadEventsFromTraceFile, setTraceModelTimeout} from '../../helpers/TraceHelpers.js';

describe('TraceProcessor', async function() {
  setTraceModelTimeout(this);

  it('can use a trace processor', async () => {
    const processor = TraceModel.Processor.TraceProcessor.createWithAllHandlers();
    const file = await loadEventsFromTraceFile('basic.json.gz');

    // Check parsing after instantiation.
    assert.isNull(processor.data);
    await processor.parse(file);
    assert.isNotNull(processor.data);

    // Check parsing without a reset.
    let thrown;
    try {
      await processor.parse(file);
    } catch (e) {
      thrown = e as Error;
    }
    assert.strictEqual(
        thrown?.message, 'Trace processor can\'t start parsing when not idle. Current state: FINISHED_PARSING');

    // Check parsing after reset.
    processor.reset();
    assert.isNull(processor.data);
    await processor.parse(file);
    assert.isNotNull(processor.data);
    // Cleanup.
    processor.reset();

    // Check simultaneous parsing without waiting.
    let promise;
    try {
      promise = processor.parse(file);
      await processor.parse(file);
    } catch (e) {
      thrown = e as Error;
    } finally {
      // Cleanup.
      await promise;
      processor.reset();
    }
    assert.strictEqual(thrown?.message, 'Trace processor can\'t start parsing when not idle. Current state: PARSING');

    // Check if data is null immediately after resetting.
    assert.isNull(processor.data);
    await processor.parse(file);
    assert.isNotNull(processor.data);
    processor.reset();
    assert.isNull(processor.data);

    // Check resetting while parsing.
    try {
      promise = processor.parse(file);
      processor.reset();
    } catch (e) {
      thrown = e as Error;
    } finally {
      // Cleanup.
      await promise;
      processor.reset();
    }
    assert.strictEqual(thrown?.message, 'Trace processor can\'t reset while parsing.');

    // Check parsing after resetting while parsing.
    assert.isNull(processor.data);
    await processor.parse(file);
    assert.isNotNull(processor.data);
  });

  it('can be given a subset of handlers to run and will run just those along with the meta handler', async () => {
    const processor = new TraceModel.Processor.TraceProcessor({
      Animation: TraceModel.Handlers.ModelHandlers.Animation,
    });
    const file = await loadEventsFromTraceFile('animation.json.gz');
    await processor.parse(file);
    assert.isNotNull(processor.data);
    assert.deepEqual(Object.keys(processor.data || {}), ['Meta', 'Animation']);
  });

  it('does not error if the user does not enable the Meta handler when it is a dependency', async () => {
    assert.doesNotThrow(() => {
      new TraceModel.Processor.TraceProcessor({
        // Screenshots handler depends on Meta handler, so this is invalid.
        // However, the Processor automatically ensures the Meta handler is
        // enabled, so this should not cause an error.
        Screenshots: TraceModel.Handlers.ModelHandlers.Screenshots,
      });
    });
  });

  it('errors if the user does not provide the right handler dependencies', async () => {
    assert.throws(() => {
      new TraceModel.Processor.TraceProcessor({
        Renderer: TraceModel.Handlers.ModelHandlers.Renderer,
        // Invalid: the renderer depends on the samples handler, so the user should pass that in too.
      });
    }, /Required handler Samples not provided/);
  });

  it('emits periodic trace updates', async () => {
    const processor = new TraceModel.Processor.TraceProcessor(
        {
          Renderer: TraceModel.Handlers.ModelHandlers.Renderer,
          Samples: TraceModel.Handlers.ModelHandlers.Samples,
        },
        {
          // These numbers are much lower than in production, which means we expect
          // updates more frequently. Otherwise, wiith the fact that most of our
          // trace files are quite small, we couldn't guarantee that we do get a
          // status update.
          pauseFrequencyMs: 10,
          pauseDuration: 1,
        });

    let updateEventCount = 0;

    processor.addEventListener(TraceModel.Processor.TraceParseProgressEvent.eventName, () => {
      updateEventCount++;
    });

    const rawEvents = await loadEventsFromTraceFile('web-dev.json.gz');
    await processor.parse(rawEvents).then(() => {
      // Ensure we saw at least one update. We cannot set a specific number as
      // it can change depending on the machine that it is being run on.
      assert.isAtLeast(updateEventCount, 1);
    });
  });

  describe('handler sorting', () => {
    const baseHandler = {
      data() {},
      handleEvent() {},
      reset() {},
    };

    function fillHandlers(
        handlersDeps: {[key: string]: {deps ? () : TraceModel.Handlers.Types.TraceEventHandlerName[]}}):
        {[key: string]: TraceModel.Handlers.Types.TraceEventHandler} {
      const handlers: {[key: string]: TraceModel.Handlers.Types.TraceEventHandler} = {};
      for (const handler in handlersDeps) {
        handlers[handler] = {...baseHandler, ...handlersDeps[handler]};
      }
      return handlers;
    }

    it('sorts handlers satisfying their dependencies 1', () => {
      const handlersDeps: {[key: string]: {deps ? () : TraceModel.Handlers.Types.TraceEventHandlerName[]}} = {
        'Meta': {},
        'GPU': {
          deps() {
            return ['Meta'];
          },
        },
        'LayoutShifts': {
          deps() {
            return ['GPU'];
          },
        },
        'NetworkRequests': {
          deps() {
            return ['LayoutShifts'];
          },
        },
        'PageLoadMetrics': {
          deps() {
            return ['Renderer', 'GPU'];
          },
        },
        'Renderer': {
          deps() {
            return ['Screenshots'];
          },
        },
        'Screenshots': {
          deps() {
            return ['NetworkRequests', 'LayoutShifts'];
          },
        },
      };
      const handlers = fillHandlers(handlersDeps);

      const expectedOrder =
          ['Meta', 'GPU', 'LayoutShifts', 'NetworkRequests', 'Screenshots', 'Renderer', 'PageLoadMetrics'];
      assert.deepEqual([...TraceModel.Processor.sortHandlers(handlers).keys()], expectedOrder);
    });
    it('sorts handlers satisfying their dependencies 2', () => {
      const handlersDeps: {[key: string]: {deps ? () : TraceModel.Handlers.Types.TraceEventHandlerName[]}} = {
        'GPU': {
          deps() {
            return ['LayoutShifts', 'NetworkRequests'];
          },
        },
        'LayoutShifts': {
          deps() {
            return ['NetworkRequests'];
          },
        },
        'NetworkRequests': {},
      };
      const handlers = fillHandlers(handlersDeps);

      const expectedOrder = ['NetworkRequests', 'LayoutShifts', 'GPU'];
      assert.deepEqual([...TraceModel.Processor.sortHandlers(handlers).keys()], expectedOrder);
    });
    it('throws an error when a dependency cycle is present among handlers', () => {
      const handlersDeps: {[key: string]: {deps ? () : TraceModel.Handlers.Types.TraceEventHandlerName[]}} = {
        'Meta': {},
        'GPU': {
          deps() {
            return ['Meta'];
          },
        },
        'LayoutShifts': {
          deps() {
            return ['GPU', 'Renderer'];
          },
        },
        'NetworkRequests': {
          deps() {
            return ['LayoutShifts'];
          },
        },
        'Renderer': {
          deps() {
            return ['NetworkRequests'];
          },
        },
      };
      const handlers = fillHandlers(handlersDeps);
      const cyclePath = 'LayoutShifts->Renderer->NetworkRequests->LayoutShifts';
      assert.throws(
          () => TraceModel.Processor.sortHandlers(handlers),
          `Found dependency cycle in trace event handlers: ${cyclePath}`);
    });
  });
});

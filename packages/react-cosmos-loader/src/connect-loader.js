// @flow

import merge from 'lodash.merge';
import { splitUnserializableParts } from 'react-cosmos-shared';
import { createContext } from './create-context';

import type { LoaderMessage } from 'react-cosmos-shared/src/types';
import type { Renderer, Proxy, Fixture, Fixtures, FixtureNames } from './types';

type Args = {
  renderer: Renderer,
  proxies: Array<Proxy>,
  fixtures: Fixtures,
  dismissRuntimeErrors?: Function
};

let unbindPrev: ?Function;

// This will be populated on fixtureSelect events
let selected: ?{
  component: string,
  fixture: string
};

// This flag is set to true in two case:
// - On fixture updates received from proxy chain via context's onUpdate handler
// - On `fixtureEdit` events triggered when user edits fixture in Playground UI
// The flag is reset to false on `fixtureSelect`, when a fixture (including the
// current one) is selected
let hasFixtureUpdate = false;

/**
 * Connect fixture context to remote Playground UI via window.postMessage.
 * In the future we'll replace window.postMessage with a fully remote (likely
 * websockets) communication channel, which will allow the Playground and the
 * Loader to live in completely different environments (eg. Control a Native
 * component instance from a web Playground UI).
 *
 * It both receives fixture edits from parent frame and forwards fixture
 * updates bubbled up from proxy chain (due to state changes) to parent frame.
 */
export async function connectLoader(args: Args) {
  const { proxies, fixtures, renderer, dismissRuntimeErrors } = args;

  async function loadFixture(fixture, notifyParent = true) {
    const { mount } = createContext({
      renderer,
      proxies,
      fixture,
      onUpdate: onContextUpdate
    });

    await mount();

    if (notifyParent) {
      // Notify back parent with the serializable contents of the loaded fixture
      const { serializable } = splitUnserializableParts(fixture);
      postMessageToParent({
        type: 'fixtureLoad',
        fixtureBody: serializable
      });
    }
  }

  function onContextUpdate(fixturePart) {
    hasFixtureUpdate = true;

    const { serializable } = splitUnserializableParts(fixturePart);
    postMessageToParent({
      type: 'fixtureUpdate',
      fixtureBody: serializable
    });
  }

  async function onMessage({ data }: LoaderMessage) {
    if (data.type === 'fixtureSelect') {
      const { component, fixture } = data;
      if (fixtures[component] && fixtures[component][fixture]) {
        selected = { component, fixture };
        hasFixtureUpdate = false;

        const selectedFixture = fixtures[component][fixture];
        await loadFixture(selectedFixture);

        if (dismissRuntimeErrors) {
          dismissRuntimeErrors();
        }
      } else {
        console.error(`[Cosmos] Missing fixture for ${component}:${fixture}`);
      }
    } else if (data.type === 'fixtureEdit') {
      if (!selected) {
        console.error('[Cosmos] No selected fixture to edit');
      } else {
        hasFixtureUpdate = true;

        // Note: Creating fixture context from scratch on every fixture edit.
        // This means that the component will always go down the
        // componentDidMount path (instead of componentWillReceiveProps) when
        // user edits fixture via fixture editor. In the future we might want to
        // sometimes update the fixture context instead of resetting it.
        const { component, fixture } = selected;
        const selectedFixture = fixtures[component][fixture];
        await loadFixture(
          applyFixturePart(selectedFixture, data.fixtureBody),
          false
        );
      }
    }
  }

  function bind() {
    window.addEventListener('message', onMessage, false);
  }

  function unbind() {
    window.removeEventListener('message', onMessage);
    unbindPrev = undefined;
  }

  const isFirstCall = !unbindPrev;

  // Implicitly unbind prev context when new one is created
  if (unbindPrev) {
    unbindPrev();
  }
  unbindPrev = unbind;

  // Always bind onMessage handler to latest input
  bind();

  if (isFirstCall) {
    // Let parent know loader is ready to render, along with the initial
    // fixture list (which might update later due to HMR)
    postMessageToParent({
      type: 'loaderReady',
      fixtures: extractFixtureNames(fixtures)
    });
  } else {
    // Keep parent up to date with fixture list
    postMessageToParent({
      type: 'fixtureListUpdate',
      fixtures: extractFixtureNames(fixtures)
    });

    if (selected && !hasFixtureUpdate) {
      const { component, fixture } = selected;
      await loadFixture(fixtures[component][fixture]);
    }
  }

  return function destroy() {
    if (unbindPrev) {
      unbindPrev();
      selected = undefined;
      hasFixtureUpdate = false;
    }
  };
}

function postMessageToParent(data) {
  parent.postMessage(data, '*');
}

function extractFixtureNames(fixtures: Fixtures): FixtureNames {
  return Object.keys(fixtures).reduce((acc, next) => {
    acc[next] = Object.keys(fixtures[next]);
    return acc;
  }, {});
}

function applyFixturePart(currentFixture: Fixture, fixturePart: {}): Fixture {
  const { unserializable, serializable } = splitUnserializableParts(
    currentFixture
  );
  return merge({}, unserializable, {
    ...serializable,
    ...fixturePart
  });
}
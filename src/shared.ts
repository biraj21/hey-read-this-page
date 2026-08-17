export const PLAYBACK_TARGET = 'playback';

export const PLAYBACK_ACTION = {
  GET_STATE: 'get-state',
  START: 'start',
  PLAY_FROM: 'play-from',
  TOGGLE: 'toggle',
  STOP: 'stop',
  SET_SETTINGS: 'set-settings',
  MARK_STALE: 'mark-stale',
} as const;

export const RUNTIME_MESSAGE = {
  ENSURE_PLAYBACK_HOST: 'playback:ensure-host',
  PLAYBACK_STATE: 'playback:state',
} as const;

export const PAGE_COMMAND = {
  CAPTURE: 'page:capture',
  FOCUS_SOURCE: 'page:focus-source',
  CLEAR_SOURCE_FOCUS: 'page:clear-source-focus',
} as const;

export const PAGE_MARKER = {
  SOURCE_ELEMENT: 'data-local-listen-source',
  SOURCE_WRAPPER: 'data-local-listen-source-wrapper',
  ACTIVE_SOURCE_ELEMENT: 'data-local-listen-active',
  ORIGINAL_BACKGROUND: 'data-local-listen-original-background',
  ORIGINAL_BACKGROUND_PRIORITY: 'data-local-listen-original-background-priority',
} as const;

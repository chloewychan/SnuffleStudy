export type WellnessState =
  | "focused"
  | "angry"
  | "disappointed"
  | "sleepy"
  | "headache"
  | "proud"
  | "concerned"
  | "celebratory";

export interface AnimationAsset {
  id: string;
  mode: "study" | "break" | "play";
  wellnessState: WellnessState;
  frames: string[];
  frameDurationMs: number;
  staticFrame: string;
}

export type AnimationRegistry = Record<string, AnimationAsset>;

function key(mode: AnimationAsset["mode"], wellnessState: WellnessState): string {
  return `${mode}:${wellnessState}`;
}

// v1 ships placeholder art only: one static frame per entry. Hand-drawn
// frame sequences replace `frames` later without touching this shape.
//
// Paths are resolved via chrome.runtime.getURL rather than root-absolute literals: this registry
// is consumed inside a content script, where a plain "/sprites/..." string resolves against the
// HOST PAGE's origin (e.g. https://youtube.com/sprites/...), not the extension's, producing a
// 404 on every real page. getURL resolves to the extension's own chrome-extension:// origin
// instead - the sprites/ directory must stay declared in wxt.config.ts's
// web_accessible_resources for the host page's document to be allowed to load it at all.
export const ANIMATION_REGISTRY: AnimationRegistry = {
  [key("study", "focused")]: {
    id: "study-focused",
    mode: "study",
    wellnessState: "focused",
    frames: [chrome.runtime.getURL("sprites/placeholder-focused.png")],
    frameDurationMs: 0,
    staticFrame: chrome.runtime.getURL("sprites/placeholder-focused.png"),
  },
  [key("study", "angry")]: {
    id: "study-angry",
    mode: "study",
    wellnessState: "angry",
    frames: [chrome.runtime.getURL("sprites/placeholder-angry.png")],
    frameDurationMs: 0,
    staticFrame: chrome.runtime.getURL("sprites/placeholder-angry.png"),
  },
  [key("study", "disappointed")]: {
    id: "study-disappointed",
    mode: "study",
    wellnessState: "disappointed",
    frames: [chrome.runtime.getURL("sprites/placeholder-disappointed.png")],
    frameDurationMs: 0,
    staticFrame: chrome.runtime.getURL("sprites/placeholder-disappointed.png"),
  },
  [key("study", "proud")]: {
    id: "study-proud",
    mode: "study",
    wellnessState: "proud",
    frames: [chrome.runtime.getURL("sprites/placeholder-proud.png")],
    frameDurationMs: 0,
    staticFrame: chrome.runtime.getURL("sprites/placeholder-proud.png"),
  },
  [key("break", "celebratory")]: {
    id: "break-celebratory",
    mode: "break",
    wellnessState: "celebratory",
    frames: [chrome.runtime.getURL("sprites/placeholder-celebratory.png")],
    frameDurationMs: 0,
    staticFrame: chrome.runtime.getURL("sprites/placeholder-celebratory.png"),
  },
};

// Guaranteed present by the ANIMATION_REGISTRY literal above; the assertion is needed
// because noUncheckedIndexedAccess widens all Record lookups to `T | undefined`, even
// for a key we know statically exists.
const DEFAULT_ASSET = ANIMATION_REGISTRY[key("study", "focused")]!;

export function getAnimationAsset(
  mode: AnimationAsset["mode"],
  wellnessState: WellnessState
): AnimationAsset {
  return ANIMATION_REGISTRY[key(mode, wellnessState)] ?? DEFAULT_ASSET;
}

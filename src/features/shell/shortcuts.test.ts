import { DEFAULT_SHORTCUTS } from "~/settings/schema";
import { shortcutActionForEvent } from "./shortcutMatching";

declare function describe(name: string, run: () => void): void;
declare function test(name: string, run: () => void): void;
declare function expect<T>(value: T): {
  toBe(expected: T): void;
  toBeNull(): void;
};

function keyboard(
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "target">
  > = {},
) {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target: null,
    ...modifiers,
  };
}

describe("focus-aware playback shortcuts", () => {
  test("does not turn the macOS line-start command into previous track", () => {
    expect(
      shortcutActionForEvent(
        keyboard("ArrowLeft", { metaKey: true }),
        DEFAULT_SHORTCUTS,
      ),
    ).toBeNull();
  });

  test("does not seek while typing in a search field", () => {
    const target = {
      tagName: "INPUT",
      isContentEditable: false,
    } as HTMLElement;
    expect(
      shortcutActionForEvent(
        keyboard("ArrowLeft", { target }),
        DEFAULT_SHORTCUTS,
      ),
    ).toBeNull();
  });

  test("keeps the configured seek shortcut outside text controls", () => {
    expect(shortcutActionForEvent(keyboard("ArrowLeft"), DEFAULT_SHORTCUTS)).toBe(
      "seekBackward",
    );
  });
});

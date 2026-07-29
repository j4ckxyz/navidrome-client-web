import { desktopClasses, detectDesktopPlatform } from "./runtime";

declare function describe(name: string, run: () => void): void;
declare function test(name: string, run: () => void): void;
declare function expect<T>(value: T): {
  toBe(expected: T): void;
  toEqual(expected: T): void;
};

describe("desktop runtime detection", () => {
  test("detects macOS WebKit", () => {
    expect(
      detectDesktopPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/605.1.15",
        "MacIntel",
      ),
    ).toBe("macos");
  });

  test("detects Windows WebView2", () => {
    expect(
      detectDesktopPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Win32",
      ),
    ).toBe("windows");
  });

  test("uses Linux as the desktop fallback", () => {
    expect(detectDesktopPlatform("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64")).toBe(
      "linux",
    );
  });

  test("only macOS receives overlay title-bar layout", () => {
    expect(desktopClasses("macos")).toEqual([
      "tauri-desktop",
      "tauri-macos",
      "tauri-overlay-titlebar",
    ]);
    expect(desktopClasses("windows")).toEqual(["tauri-desktop", "tauri-windows"]);
  });
});

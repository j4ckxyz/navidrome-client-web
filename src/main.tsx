/* @refresh reload */
import { render } from "solid-js/web";
import { QueryClientProvider } from "@tanstack/solid-query";
import { queryClient } from "~/lib/query";
import { ThemeProvider } from "~/theme/provider";
import { initSession } from "~/auth/session";
import { player } from "~/player/store";
import { App } from "./App";

import "~/styles/global.css";
import "~/pages/pages.css";

// Restore a prior session and queue before first paint.
initSession();
player.restoreQueue();

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  ),
  root,
);

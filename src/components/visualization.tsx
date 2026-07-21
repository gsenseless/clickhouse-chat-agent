"use client";

import { JSONUIProvider, Renderer } from "@json-render/react";
import { Component, type ReactNode, useEffect, useRef } from "react";
import type { VisualizationSpec } from "@/lib/catalog";
import { registry } from "@/lib/registry";

const DEBUG_ENABLED = ["1", "true", "on"].includes(
  (process.env.NEXT_PUBLIC_CHAT_DEBUG ?? "1").toLowerCase()
);

// Specs render as soon as they finish streaming — before the tool's
// validation result lands — so a bad spec must degrade to an inline
// message rather than crash the chat.
class VisualizationErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="my-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Couldn&apos;t render this visualization.
        </div>
      );
    }
    return this.props.children;
  }
}

export function Visualization({ spec }: { spec: VisualizationSpec }) {
  const mountedAt = useRef<number>(Date.now());

  useEffect(() => {
    if (!DEBUG_ENABLED) return;
    console.log("[chat-ui/visualization-rendered]", {
      durationMs: Date.now() - mountedAt.current,
      root: spec.root,
      elementCount: Object.keys(spec.elements).length,
    });
  }, [spec]);

  return (
    <div className="my-3">
      <VisualizationErrorBoundary
        onError={(error) => {
          if (!DEBUG_ENABLED) return;
          console.error("[chat-ui/visualization-error]", {
            message: error.message,
            root: spec.root,
          });
        }}
      >
        <JSONUIProvider registry={registry}>
          <Renderer spec={spec} registry={registry} />
        </JSONUIProvider>
      </VisualizationErrorBoundary>
    </div>
  );
}

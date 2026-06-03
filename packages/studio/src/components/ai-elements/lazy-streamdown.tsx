"use client";

import { lazy, Suspense } from "react";
import type { StreamdownProps } from "streamdown";

type StreamdownPluginSet = "full" | "cjk";

type LazyStreamdownProps = StreamdownProps & {
  readonly pluginSet?: StreamdownPluginSet;
};

const FullStreamdown = lazy(async () => {
  const [
    streamdownModule,
    cjkModule,
    codeModule,
    mathModule,
    mermaidModule,
  ] = await Promise.all([
    import("streamdown"),
    import("@streamdown/cjk"),
    import("@streamdown/code"),
    import("@streamdown/math"),
    import("@streamdown/mermaid"),
  ]);
  const Streamdown = streamdownModule.Streamdown;
  const plugins = {
    cjk: cjkModule.cjk,
    code: codeModule.code,
    math: mathModule.math,
    mermaid: mermaidModule.mermaid,
  };

  return {
    default: function FullStreamdownRenderer(props: StreamdownProps) {
      return <Streamdown plugins={plugins} {...props} />;
    },
  };
});

const CjkStreamdown = lazy(async () => {
  const [streamdownModule, cjkModule] = await Promise.all([
    import("streamdown"),
    import("@streamdown/cjk"),
  ]);
  const Streamdown = streamdownModule.Streamdown;
  const plugins = { cjk: cjkModule.cjk };

  return {
    default: function CjkStreamdownRenderer(props: StreamdownProps) {
      return <Streamdown plugins={plugins} {...props} />;
    },
  };
});

export function LazyStreamdown({
  pluginSet = "full",
  className,
  children,
  ...props
}: LazyStreamdownProps) {
  const Renderer = pluginSet === "cjk" ? CjkStreamdown : FullStreamdown;
  return (
    <Suspense fallback={<div className={className}>{children}</div>}>
      <Renderer className={className} {...props}>
        {children}
      </Renderer>
    </Suspense>
  );
}

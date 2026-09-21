import * as React from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "tg-emoji": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "emoji-id"?: string;
        },
        HTMLElement
      >;
    }
  }
}

/**
 * Spatial AI Labs mark — the isometric-cube glyph from the brand SVGs
 * (business-card set), cropped from the original A4 page to its exact path
 * bounds and filled with currentColor: the supplied dark/light variants
 * differ only in color, so one component serves every surface. Size it
 * with className (e.g. size-5); pass aria-hidden context via props if the
 * default (decorative) is wrong somewhere.
 */

import type { SVGProps } from "react";

export function Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="1584.209 986.007 457.575 437.446"
      fill="currentColor"
      aria-hidden
      {...props}
    >
      <path
        fillRule="nonzero"
        d="M1812.83,1099.44l130.829,75.533l0,151.071l32.709,18.884l-0,-188.78l-163.538,-94.416l0,37.708Zm0,-113.433l0,37.812l196.246,113.3l-0,226.692l32.708,18.883l0,-264.5l-228.954,-132.187Zm0,264.504l130.829,75.533l-130.829,75.538l-130.5,-75.346l0,97.217l-98.121,-0l0,-97.592l97.792,-0l-0,-150.888l130.829,-75.533l0,151.071Z"
      />
    </svg>
  );
}

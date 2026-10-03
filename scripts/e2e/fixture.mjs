import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HERE } from "./lib.mjs";

export const PROJ = join(HERE, "proj");
export const PROJ_FWD = PROJ.replaceAll("\\", "/");
export const NEWPROJ_PARENT = join(HERE, "newproj");

import { crc32, deflateSync } from "node:zlib";

/** Build a valid 16x16 solid red RGB PNG. */
function makePng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const w = 16, h = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = makePng();

export async function makeFixture() {
  await rm(PROJ, { recursive: true, force: true });
  await rm(NEWPROJ_PARENT, { recursive: true, force: true });
  await mkdir(join(PROJ, "chapters"), { recursive: true });
  await mkdir(join(PROJ, "figures"), { recursive: true });
  await mkdir(NEWPROJ_PARENT, { recursive: true });
  const files = {
    "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage{graphicx}
\title{E2E Demo}
\author{Tester}
\begin{document}
\maketitle
\input{chapters/intro}
\section{Method}\label{sec:method}
As shown in Section~\ref{sec:intro} and Eq.~\eqref{eq:int}, see \cite{knuth1984}.
% TODO: expand the method section
\begin{equation}
  \int_0^1 x^2\,dx = \frac{1}{3}
  \label{eq:int}
\end{equation}
\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.2\linewidth]{figures/dot.png}
  \caption{A dot}\label{fig:dot}
\end{figure}
\section{Results}
Results go here.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`,
    "chapters/intro.tex": String.raw`\section{Introduction}\label{sec:intro}
This is the introduction. % FIXME: cite related work
It has two sentences.
`,
    "notes.tex": String.raw`\documentclass{article}
\begin{document}
Notes document, a second root.
\end{document}
`,
    "broken.tex": String.raw`\documentclass{article}
\begin{document}
Hello \undefinedmacro{x} world.
\end{document}
`,
    "rules-sample.tex": "% rule check samples (not compiled)\n中文English混排没有空格。\n这是第一段\n这是第二段\n",
    "refs.bib": String.raw`@book{knuth1984,
  title={The TeXbook},
  author={Knuth, Donald E.},
  year={1984},
  publisher={Addison-Wesley}
}
@article{lamport1994,
  title={LaTeX: A Document Preparation System},
  author={Lamport, Leslie},
  year={1994},
  journal={Addison-Wesley}
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(PROJ, rel), content, "utf8");
  }
  await writeFile(join(PROJ, "figures", "dot.png"), PNG);
  await writeFile(join(HERE, "extra.png"), PNG);
}

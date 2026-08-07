# ANU MAE thesis template

A LaTeX template for the Master of Philosophy (Applied Epidemiology) (MAE) program at Australian National University (ANU). The MAE program does not use a traditional theses structure, instead it is made up of multiple projects, each with their own reference list and appendices.

This template was created by me (Holly Gibbons, MAE 2025), to help future MAE students with formatting, allowing them to focus more on their projects and engaging in their field placements. I am hoping this will help Scholars get started on their thesis without needing to build a LaTeX setup from scratch. The original code and structure are my own work, developed for my own thesis; Claude (Anthropic's AI assistant) was used to assist in developing and documenting the template.

If you run into any issues using this template, or if there is anything you would like to see added or improved, I would be very happy to hear from you :)

Best of luck with your thesis!!!!!!!!!!!

---

## What is LaTeX?
### A guide for MAE students (no LaTeX experience required)

LaTeX (pronounced "lah-tech") is a document preparation system. Instead of formatting as you type (like Word), you write your content in plain text files (`.tex` files) and LaTeX automatically handles all the formatting.

**The key benefits for the MAE thesis:**
* References for each chapter are generated automatically
* Figures and tables are numbered and listed automatically, with updates applied when changes are made
* The table of contents updates automatically as content is added
* A list of abbreviations is generated automatically
* Cross-referencing and hyperlinks remain functional when compiled as a PDF
* No need to combine multiple PDFs or Microsoft Word documents to produce a complete thesis

You write your content in `.tex` files using Overleaf (or a local text editor). When you click **Recompile** in Overleaf, LaTeX processes all the files and produces a PDF.

---

## Overview of template structure

```
├── main.tex                             # Master document — start here
├── preamble.tex                         # All packages, fonts, and formatting
├── abbreviations.tex                    # Abbreviation definitions
├── reference_library.bib                # BibTeX bibliography
│
├── front_matter/
│   ├── abstract.tex
│   ├── acknowledgement.tex
│   ├── abbreviations_static.tex         # Printed abbreviations list (auto-generated)
│   └── originality_statement.tex
│
├── titlepage/
│   ├── titlepage.tex
│   └── anu-logo-colour.pdf
│
├── experience/experience.tex            # Ch 1: Placement overview and competencies
├── data_analysis/data_analysis.tex      # Ch 2: Project 1 — Data analysis
├── surveillance/surveillance.tex        # Ch 3: Project 2 — Surveillance system
├── epistudy/epistudy.tex                # Ch 4: Project 3 — Epidemiological study
├── outbreak/outbreak.tex                # Ch 5: Project 4 — Outbreak investigation
└── teaching/teaching.tex                # Ch 6: Teaching and field activities
```

---

## Getting started

The template can be downloaded and used in either online or locally on your computer. Please see the comparison table below to help decide which one is best for you.

| Online (Overleaf) | Locally (TeXstudio)|
|----------|--------|
| Runs in your browser | Runs on your computer |
| No software installation required | Requires installing a LaTeX distribution and tools |
| Compilation happens on Overleaf servers | Compilation happens locally on your machine |
| Easy setup and quick to get started | More setup required initially |
| Built-in collaboration and sharing | Collaboration requires external tools (e.g., Git) |
| Limited control over environment | Full control over packages and build process |
| Requires internet connection | Works offline |
| Suitable for beginners | Better for advanced users or large projects |

### How to open the template in online (Overleaf)

All ANU staff and students have access to Overleaf's professional upgrades if they login with single sign-on (SSO) and use their university email address. Please find additional support regarding the use of Overleaf through ANU [here](https://services.anu.edu.au/information-technology/software-systems/overleaf).

1. Download this repository as a ZIP file (*GitHub → Code → Download ZIP*)
2. In Overleaf: *New Project → Upload Project* → select the ZIP
3. Open *Menu* (top left) → *Compiler* → select **pdfLaTeX**
4. Click **Recompile**

---

> **Before you write anything in Overleaf**
>
> Check with your field supervisor that you have permission to use a cloud-based platform such as Overleaf before uploading any thesis content.
>
> Data sharing and confidentiality obligations can vary between placements. As an example of one approach, my placement agreed that I could use Overleaf provided that:
> 1. only tables and figures were uploaded (no raw data) and
> 2. any content written or uploaded was approved by my supervisor before being added to the project
>
> Your placement may have different requirements. If in doubt, ask your field supervisor before you begin.

---

### How to open the template locally (TeXstudio)

#### Step 1: Download and install MiKTeX

MiKTeX is the LaTeX engine that compiles your `.tex` files into a PDF.

1. Go to [miktex.org/download](https://miktex.org/download) and download the Windows installer
2. Run the installer — accept all defaults
3. When asked *"Install missing packages on-the-fly"*, select **Yes**
4. After installation, open the **MiKTeX Console** (search for it in the Start menu) and click **Check for updates**, then install any available updates

#### Step 2: Download and install TeXstudio

TeXstudio is the editor you write and compile your thesis in.

1. Go to [texstudio.org](https://www.texstudio.org) and download the Windows installer
2. Run the installer — accept all defaults

#### Step 3: Configure the TeXstudio build sequence

This is the most important step. By default, TeXstudio only runs one compile pass and misses the bibliography and abbreviations. You need to tell it to run the full sequence.

1. Open TeXstudio
2. Go to **Options → Configure TeXstudio → Build**
3. Find the **"Build & View"** field (it will contain something like `txs:///compile | txs:///view`)
4. Replace the entire contents of that field with:

```
txs:///pdflatex | txs:///biber | txs:///makeglossaries | txs:///pdflatex | txs:///pdflatex | txs:///view-pdf-internal
```

5. In the same Build panel, set:
   - **Default Compiler:** pdfLaTeX
   - **Default Bibliography Tool:** Biber

6. Click **OK**

#### Step 4: Open the template

1. Download this repository as a ZIP file (*GitHub → Code → Download ZIP*)
2. Extract the ZIP to a folder on your computer (e.g. `Documents/thesis`)
3. In TeXstudio: **File → Open** → navigate to the folder and open `main.tex`

#### Step 5: Compile

Press **F5** (Build & View). TeXstudio will run pdflatex, biber, makeglossaries, and pdflatex twice automatically. The PDF will open in the panel on the right when compilation is complete.

> **First compile note:** MiKTeX may prompt you to install missing packages on-the-fly the first time you compile. Click **Install** for each — this only happens once.

> **If you see warnings but a PDF is produced**, that is normal for the first compile. Press **F5** again if any cross-reference numbers look wrong.

---


## Setting up reference integration

I suggest using a reference management software such as Zotero. I have outlined two options for setting up reference integration with Zotero below.

If you are using Overleaf, I do not suggest using the automated integration with Zotero because the imported reference entries cannot be edited and are harder to format.

### Option A: One-time export
1. In Zotero, select your library or a collection
2. **File → Export Library** (or right-click a collection → **Export Collection**)
3. Save and replace `reference_library.bib` files:
   
   - **Overleaf:** Save as `reference_library.bib` and replace the existing file in your project
  
   - **Locally:** Replace the `reference_library.bib` file in the `ANU-MAE-thesis-template-main` folder (downloaded from Git)

### Option B: Continuous sync (recommended)
1. Install the [Better BibTeX plugin](https://retorque.re/zotero-better-bibtex/) for Zotero
2. Right-click your Zotero library or collection → **Export Collection**
   - Format: **Better BibLaTeX**
     
   - Tick **Keep updated**
3. Save as `reference_library.bib`
   
   - **Overleaf:** Save as `reference_library.bib` and replace the existing file in your project
  
   - **Locally:** Replace the `reference_library.bib` file in the `ANU-MAE-thesis-template-main` folder (downloaded from Git)
  
4. Zotero keeps the exported `.bib` file up to date on your computer automatically

   - **Overleaf:** Re-upload to Overleaf whenever you add new references
  
   - **Locally:** File will automatically update


## Customising the template

### Step 1: Fill in your details

**Title page:**

1. Open `titlepage/titlepage.tex` and replace the placeholder text:

| Find this | Replace with |
|---|---|
| `TITLE OF THESIS` | Your thesis title |
| `AUTHOR FULL NAME` | Your full name |
| `YEAR -- YEAR` | e.g. `2024 -- 2026` |
| `PLACEMENT UNIT,` | Your unit name |
| `PLACEMENT DEPARTMENT` | Your department/organisation |
| `Dr SUPERVISOR NAME` | Your academic supervisor |
| `Ms SUPERVISOR NAME 1` | Your first field supervisor |
| `Mr SUPERVISOR NAME 2` | Your second field supervisor (remove if not needed)|

2. Open `titlepage/` folder and upload placement organisation logo (as a `.png` or `.pdf`).

- In `titlepage/titlepage.tex` replace `nike.png` with the file name of your logo

**Originality statement:**

3. Open `originality_statement.tex` in the `Front Matter` folder
- `PLACEMENT` → Your department/organisation

4. In `preamble.tex` search: `% ===================== Front Matter Environments =====================`
- `YOUR FULL NAME` → your name
- `DATE OF SUBMISSION` → e.g. `1st~October~2025`
  *(The `~` symbol prevents a line break between the day and month)*
- `30,000` → update word count

**Hyperlinks:**

5. Open `preamble.tex` and search: `% ===================== Hyperlinks =====================`
- `THESIS TITLE` → your thesis title
- `YOUR FULL NAME` → your name
- Add relevant keywords separated by commas

---

### Step 2: Choose your document format

ANU requires different margins depending on how your thesis is submitted. The template defaults to the digital submission format. If you need to produce a print-ready version, change **one line in the `main.tex` and `preamble.tex` files**, keeping the option number the same in both.

1. **In `main.tex`**, activate the correct `\documentclass` option:

| Option | When to use |
|---|---|
| Option 1 (default) | Digital submission (all margins 2.5 cm)|
| Option 2 | Hard copy, single-sided printing (binding margin 4 cm) |
| Option 3 | Hard copy, double-sided printing (inner binding margin 4 cm) |

2. **In `preamble.tex`**, activate the matching `\usepackage{geometry}` option (same option number).

To activate an option, remove the `%` at the start of that line, and add `%` to the start of the currently active line.

---

### Step 3: Name your chapters

Open each chapter file and replace `PROJECT TITLE 1` (or 2, 3, 4) with your actual project title:

| File | Replace |
|---|---|
| `data_analysis/data_analysis.tex` | `PROJECT TITLE 1` → your data analysis project title |
| `surveillance/surveillance.tex` | `PROJECT TITLE 2` → your surveillance project title |
| `epistudy/epistudy.tex` | `PROJECT TITLE 3` → your epidemiological study title |
| `outbreak/outbreak.tex` | `PROJECT TITLE 4` → your outbreak investigation title |

---

### Step 4: Write your content

Each chapter is a separate `.tex` file. Open the file for the chapter you want to write and add your text below the relevant section heading.

#### How text works in LaTeX

- Type normally, a blank line between paragraphs creates a new paragraph
- No need to indent paragraphs (the template handles this)
- **Bold text:** `\textbf{your text}`
- *Italic text:* `\textit{your text}`

#### Special characters

These characters have special meaning in LaTeX. If you need to type them in your text, use the version in the right column:

| Character | How to type it |
|---|---|
| `%` (percent) | `\%` |
| `&` (ampersand) | `\&` |
| `$` (dollar sign) | `\$` |
| `_` (underscore) | `\_` |
| `#` (hash) | `\#` |
| `--` (en-dash, for ranges) | `--` |
| `---` (em-dash) | `---` |
| `''` (open quote) | ` `` ` (two backticks) |
| `''` (close quote) | `''` (two apostrophes) |

---

### Step 5: Add a figure

A figure is any image, an epicurve, a map, a chart exported from R/Stata/SPSS/Excel.

1. **Save your image file** (as `.png` or `.pdf`) in the relevant chapter folder, e.g. `data_analysis/figures/`.
2. **Then add this block** in your chapter where you want the figure to appear:

```latex
\begin{figure}[H]
    \centering
    \includegraphics[width=0.85\textwidth]{data_analysis/figures/my_figure.png}
    \caption{Weekly case counts by symptom onset date, Location, Month Year.}
    \label{fig:epicurve}
\end{figure}
```

**What each line means:**

| Syntax | Description |
|---|---|
| `[H]` | Places the figure **H**ere (at this exact position in the text) |
| `\centering` | Centres the image on the page |
| `width=0.85\textwidth` | Sets the image width to 85% of the text width (adjust as needed) |
| `{data_analysis/figures/my_figure.png}` | The path to your image file |
| `\caption{...}` | The caption that appears **below** the figure |
| `\label{fig:epicurve}` | A unique name for cross-referencing, **must start with `fig:`** |

**Cross referencing the figure in your chapter:**

```latex
As shown in \cref{fig:epicurve}, cases peaked in week 3.
```

This produces: "As shown in Figure 1, cases peaked in week 3."\
The figure number will update automatically if you add or move figures.

---

### Step 6: Add a table

The simplest approach is to export your table from R, Stata, or Excel as a `.png` image and include it like a figure but inside a `table` environment so LaTeX treats it as a table (numbering it in the list of tables).

1. **Save your table image** in the relevant chapter folder, e.g. `data_analysis/tables/`.
2. **Then add this block** in your chapter where you want the table to appear:

```latex
\begin{table}[H]
    \caption{Number of cases by age group, Location, Year.}
    \label{tab:age_groups}
    \centering
    \begin{tabular}{c}
        \includegraphics[width=0.95\textwidth]{data_analysis/tables/age_table.png}
    \end{tabular}
\end{table}
```

**Cross referencing the table in your chapter:**

```latex
\cref{tab:age_groups} shows the distribution of cases by age group.
```

This produces: "Table 1 shows the distribution of cases by age group."\
The table number will update automatically if you add or move tables.

---

### Step 7: Abbreviations

The abbreviations system works in two places that are connected automatically:

- **`abbreviations.tex`:** File where you define abbreviations. This drives both the in-text expansion and the printed front matter list. I have kept all the abbreviations I used for my thesis, feel free to add or remove abbrevations.
  
- **`front_matter/abbreviations_static.tex`:** Abbreviations page printed in the thesis front matter. This generates a list of abbrevations that were actually used within your chapters. You do not need to edit this `.tex` file.

#### Defining an abbreviation

Open `abbreviations.tex` and add a line:

```latex
\newabbreviation{WHO}{WHO}{World Health Organization}
```

The three parts are:
1. `{WHO}`: the **key** (what you type in `\gls{WHO}` — must be unique, no spaces)
2. `{WHO}`: the **short form** (what appears after first use, e.g. "WHO")
3. `{World Health Organization}`: the **long form** (what appears on first use)

#### Using an abbreviation in your text

Type `\gls{KEY}` wherever you want the abbreviation to appear:

```latex
Data were submitted to the \gls{WHO} surveillance system.
```

- **First use in the chapter:** "Data were submitted to the World Health Organization (WHO) surveillance system."
- **All subsequent uses:** "Data were submitted to the WHO surveillance system."

Abbreviation tracking resets automatically at the start of each chapter, so each chapter re-expands abbreviations on first use. This is handled by `\glsresetall[abbreviations]` in each chapter file.

#### For plural forms

```latex
\glspl{RACF}
```

To define a plural, use this format in `abbreviations.tex`:

```latex
\newabbreviation[
  longplural  = {residential aged care facilities},
  shortplural = {RACFs}
]{RACF}{RACF}{residential aged care facility}
```

#### The front matter list

The abbreviations page in the front matter is generated automatically. It lists abbreviations in alphabetical order, in the same visual style as the rest of the front matter. If you do not use `\gls{}` in your text for an abbreviation it will not be included in your automatically generated abbrevation list in the front matter.

**You do not need to edit `front_matter/abbreviations_static.tex`.** Recompile your document (twice if needed in Overleaf) and the list updates itself.

> **If an abbreviation is missing from the front matter list**, check that you used `\gls{KEY}` in your text, abbreviations typed manually (not via `\gls{}`) are not tracked.

---

### Step 8: Citing references in `.tex` files

Follow the instrcutions provided for [setting up reference integration](https://github.com/hollyfgibbons/ANU-MAE-thesis-template/blob/main/README.md#setting-up-reference-integration).

Your `reference_library.bib` file will contain reference entires similar to the examples below:

**Journal article:**
```bibtex
@article{smith_article_title_2024,
  title        = {Title of the article},
  author       = {Smith, John and Jones, Mary},
  journaltitle = {Journal of Applied Epidemiology},
  volume       = {10},
  number       = {2},
  pages        = {100--110},
  date         = {2024},
  doi          = {10.0000/example},
}
```

**Website:**
```bibtex
@online{who_webpage_2025,
  title   = {Title of the webpage},
  author  = {{World Health Organization}},
  url     = {https://www.who.int/example},
  urldate = {2025-06-01},
  date    = {2025-01-01},
}
```

You will need the **Citation Key** for each of your references in order to cite them.

In these examples, the citation key is the first item after `@article{` or `@online{`: which are `smith_article_title_2024` and `who_webpage_2025`.

Citation key's can also be found in the citation key column in Zotero. To view the citation key column in Zotero:
1. Install Better BibTeX
2. **View → Columns → More Columns → Citation Key**

```latex
Write text that requires referencing here.\cite{smith_article_title_2024}   % → superscript number in text
```

This inserts a superscript number (e.g. ¹) in your text. The full reference appears automatically in the **References** section at the end of that chapter, you do not need to do anything else.

**Cite multiple references at once:**

```latex
This finding has been reported across several studies.\cite{smith_article_title_2024,who_webpage_2025}
```
This inserts compressed superscripts like ¹⁻³.

---

### Step 9: Cross-referencing

You can reference any chapter, section, figure, table, or appendix anywhere in the document:

```latex
\cref{chap:project_1}    →  "Chapter 2"
\cref{fig:epicurve}      →  "Figure 1"
\cref{tab:age_groups}    →  "Table 1"
\cref{app:lay_summary}   →  "Appendix A"
```

The label must be defined in the relevant file with `\label{...}`. Each chapter file already has its label defined at the top (e.g. `\label{chap:project_1}`).

---

### Step 10: Add or modify sections

Each chapter uses `\section{}`, `\subsection{}`, and `\subsubsection{}` to organise content:

```latex
\section{Methods}
\subsection{Study population}
\subsubsection{Inclusion criteria}
```

LaTeX numbers them automatically. To add a new section, copy a `\section{}` line and change the title. To remove a section, delete it.

Sections at the paragraph level (for detailed sub-points) use:

```latex
\paragraph*{Confirmed case}
% text here
\paragraph*{Probable case}
% text here
```

The `*` means the paragraph heading is not numbered.

---

### Step 11: Add an appendix to a chapter

Each chapter has a `\begin{subappendices}...\end{subappendices}` block at the end. Inside it, each appendix is a `\section{}`.

PDF appendices (e.g. a factsheet, presentation slides, or manuscript) are included one page at a time using `\includegraphics`. Add one line per page:

```latex
\begin{subappendices}

\clearpage
\section{Lay summary}
\label{app:lay_summary}
\nopagebreak
\centering
\includegraphics[page=1,width=\textwidth]{data_analysis/appendices/factsheet.pdf}
\clearpage
\includegraphics[page=2,width=\textwidth]{data_analysis/appendices/factsheet.pdf}
% Add more lines for additional pages
\RaggedRight

\end{subappendices}
```

Upload your file to the chapter's `appendices/` subfolder before compiling. Adjust the number of `\includegraphics` lines to match the number of pages in your PDF.

---

### Step 12: Remove empty local lists

At the top of each chapter there is a local list of tables and a local list of figures. If a chapter has no tables or figures, these pages will be blank and should be removed.

**To remove an empty local list**, find these lines near the top of the chapter file and delete them (or add a `%` at the start of each line to comment them out):

```latex
\locallistoftables    % remove if this chapter has no tables
\locallistoffigures   % remove if this chapter has no figures
\clearpage            % remove this \clearpage if you removed both lists above
```

---


## Reference lists for each chapter

Each chapter file ends with:

```latex
\clearpage
\addcontentsline{toc}{section}{References}
\printbibliography[heading=subbibliography, title={References}]
```

Only references cited within that chapter appear in that chapter's list. Numbers restart at [1] in each chapter.

---

## Reordering chapters

In `main.tex`, simply reorder the `\include` lines, all numbering updates automatically:

```latex
\include{experience/experience}
\include{data_analysis/data_analysis}
\include{surveillance/surveillance}
\include{epistudy/epistudy}
\include{outbreak/outbreak}
\include{teaching/teaching}
```

---

## Troubleshooting

| Problem | Likely cause | Solution |
|---|---|---|
| Red error in Overleaf | Syntax error (missing `}` or `\end{}`) | Click the log icon — it shows the file and line number |
| `Undefined control sequence` | Misspelled command | Check spelling — LaTeX is case-sensitive |
| `Citation ... undefined` warning | Key in `\cite{}` does not match `.bib` file | Check the key matches exactly (case-sensitive) |
| Figure or table number is wrong | Another figure was added or removed | Click Recompile twice — numbers auto-update |
| Abbreviation does not expand | Not defined in `abbreviations.tex` | Add the `\newabbreviation{}` entry |
| Abbreviation missing from front matter list | Used manually in text, not via `\gls{}` | Replace the manual text with `\gls{KEY}` |
| Text runs off the page | Very long unbreakable word or URL | Wrap in `\url{}` or add `\-` to suggest a hyphen point |
| Blank page between chapters | Normal for double-sided layout | Expected — leave it; or switch to Option 1 or 2 in `main.tex` and `preamble.tex` |
| Overleaf times out on compile | Very large PDF appendices | Compress your appendix PDFs before uploading |

---

## Quick reference

| Task | Command |
|---|---|
| Bold text | `\textbf{text}` |
| Italic text | `\textit{text}` |
| New page | `\clearpage` |
| Use abbreviation | `\gls{KEY}` |
| Use abbreviation (plural) | `\glspl{KEY}` |
| In-text citation | `\cite{key}` |
| Cross-reference | `\cref{label}` |
| Cross-reference (sentence start) | `\Cref{label}` |
| Label a figure | `\label{fig:name}` inside `\begin{figure}` |
| Label a table | `\label{tab:name}` inside `\begin{table}` |
| Label a section | `\label{sec:name}` after `\section{}` |
| Comment a line | Add `%` at the start of the line |
| En-dash (number ranges) | `--` (e.g. `2020--2024`) |
| Em-dash | `---` |
| Non-breaking space | `~` (e.g. `Figure~1`) |

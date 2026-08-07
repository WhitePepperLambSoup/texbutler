# latexmkrc — local build configuration
# Compiler: pdfLaTeX + Biber + makeglossaries
#
# Usage:
#   latexmk main.tex        # build (handles pdflatex + biber + glossaries automatically)
#   latexmk -C              # clean all auxiliary files
#   latexmk -pv main.tex    # build and open PDF viewer

$pdf_mode   = 1;   # use pdflatex
$bibtex_use = 2;   # use biber instead of bibtex

$pdflatex = 'pdflatex -interaction=nonstopmode -synctex=1 %O %S';

# Run makeglossaries automatically when glossary files need updating
# Standard glossaries extensions
add_cus_dep('glo', 'gls', 0, 'makeglossaries');
add_cus_dep('acn', 'acr', 0, 'makeglossaries');
# glossaries-extra [abbreviations] type uses .glo-abr / .gls-abr (e.g. on Overleaf)
add_cus_dep('glo-abr', 'gls-abr', 0, 'makeglossaries');
sub makeglossaries {
    my $base = $_[0];
    if ( $^O =~ /MSWin/i ) {
        system("makeglossaries \"$base\"");
    } else {
        system("makeglossaries '$base'");
    }
    return 0;
}

# Clean these extra files with latexmk -C
$clean_ext = 'glo gls glg acn acr alg bbl run.xml synctex.gz glo-abr gls-abr glg-abr';

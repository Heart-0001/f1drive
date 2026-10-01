# python pdftext.py <pdf> ... : text of each FIA PDF next to it (<name>.txt), via pypdf
import sys
from pypdf import PdfReader
for p in sys.argv[1:]:
    try:
        r = PdfReader(p)
        t = '\n'.join(f'--- page {i + 1}\n' + (pg.extract_text() or '') for i, pg in enumerate(r.pages))
    except Exception as e:
        t = 'ERROR ' + str(e)
    open(p[:-4] + '.txt', 'w', encoding='utf-8').write(t)
    print(p, len(t))

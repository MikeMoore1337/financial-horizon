"""Generate a tiny *synthetic* XLSX with only Python's standard library."""
from __future__ import annotations
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

def worksheet():
 cells={
  "A1":"Кредитная нагрузка",
  "I1":"Зарплата, 15 число","J2":82000,
  "I3":"Интернет E2E","J3":850,"K3":"22 число",
  "I15":"Аванс, 30 число","J16":83000,
  "I17":"Продукты E2E","J17":1500,"K17":"18 число",
 }
 rows=[]
 for n in sorted({int(''.join(c for c in k if c.isdigit())) for k in cells}):
  xs=[]
  for ref,value in cells.items():
   if int(''.join(c for c in ref if c.isdigit()))!=n:continue
   if isinstance(value,(float,int)):
    xs.append(f'<c r="{ref}"><v>{value}</v></c>')
   else:
    xs.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
  rows.append(f'<row r="{n}">{"".join(xs)}</row>')
 return '<?xml version="1.0" encoding="UTF-8"?>' + (
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  '<sheetData>'+"".join(rows)+'</sheetData></worksheet>')

def build(path:Path):
 path.parent.mkdir(parents=True,exist_ok=True)
 with ZipFile(path,'w',ZIP_DEFLATED,compresslevel=6) as z:
  z.writestr("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
  z.writestr("xl/workbook.xml",'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Расходы" sheetId="1" r:id="rId1"/></sheets></workbook>')
  z.writestr("xl/_rels/workbook.xml.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
  z.writestr("xl/worksheets/sheet1.xml",worksheet())

if __name__=="__main__":
 build(Path(sys.argv[1]))

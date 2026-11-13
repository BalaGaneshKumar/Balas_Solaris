"""
export_api.py — ONE shared file-export endpoint, reused by every tab's
"Beam Down" / download button (Job Odyssey first, Career next). Deliberately
knows almost nothing about which tab the rows came from beyond the presence
of a 'status' or 'stage' column (used only to pick a color-coding scheme for
XLSX) — same generic contract as source's /api/export-file.

POST /api/export-file
  body: {
    rows:     [ {key: value, ...}, ... ]
    columns:  [ {key, label}, ... ]   (order = column order in the file)
    filename: 'job_odyssey_export'    (no extension)
    format:   'csv' | 'xlsx'
  }
  -> the file itself, as an attachment download (not JSON)

CSV via Python's csv module (handles embedded commas/newlines, utf-8-sig
BOM so Excel opens it with the right encoding). XLSX via openpyxl,
write_only mode (source's own comment: ~4s -> well under 1s for ~2,900
rows x 12 cols by avoiding per-cell object overhead), bold frozen header,
color-coded rows by status (Job Odyssey) or stage (Career, once wired).
"""

import csv
import io
import json
import re
import sys

from flask import Blueprint, request, Response

export_api_bp = Blueprint("export_api", __name__)

JO_STATUS_FILL = {
    'eligible':   'C8E6C9',  # light green
    'applied':    'BBDEFB',  # light blue
    'hold':       'FFF9C4',  # light yellow
    'ineligible': 'FFCDD2',  # light red
    'blacklist':  'E0E0E0',  # gray
}
APP_STAGE_FILL = {
    'Offer':       'C8E6C9',
    'Interview':   'BBDEFB',
    'In Progress': 'E1F5FE',
    'Applied':     'FFF9C4',
    'Rejected':    'FFCDD2',
    'Ghosted':     'E0E0E0',
    'Withdrawn':   'ECEFF1',
    'Closed':      'ECEFF1',
}


# Characters XML (and so XLSX) can't contain — openpyxl raises
# IllegalCharacterError on them. Scraped text (job descriptions in
# particular) picks up stray vertical-tabs / form-feeds / etc. often
# enough that one bad cell used to fail the whole export, while CSV —
# which has no such restriction — worked fine for the very same rows.
_XLSX_ILLEGAL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def _xlsx_safe(v):
    """Coerce one cell value into something openpyxl will accept:
    None -> blank, lists/dicts -> readable text (openpyxl can't write
    them and raises), control characters stripped from any text."""
    if v is None:
        return ''
    if isinstance(v, bool) or isinstance(v, (int, float)):
        return v
    if isinstance(v, (list, tuple, set)):
        v = ', '.join(str(x) for x in v)
    elif isinstance(v, dict):
        v = json.dumps(v, ensure_ascii=False, default=str)
    else:
        v = str(v)
    return _XLSX_ILLEGAL.sub('', v)


def _build_xlsx_bytes(rows, keys, labels):
    from openpyxl import Workbook
    from openpyxl.cell import WriteOnlyCell
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    wb = Workbook(write_only=True)
    ws = wb.create_sheet('Export')
    # In write_only mode, freeze_panes must be set BEFORE the first
    # append() call or it silently fails to persist on save.
    ws.freeze_panes = 'A2'

    header_font = Font(name='Arial', bold=True, color='FFFFFF')
    header_fill = PatternFill('solid', fgColor='3949AB')
    header_align = Alignment(vertical='center')
    body_font = Font(name='Arial')

    header_cells = []
    for label in labels:
        c = WriteOnlyCell(ws, value=label)
        c.font = header_font
        c.fill = header_fill
        c.alignment = header_align
        header_cells.append(c)
    ws.append(header_cells)

    status_idx = keys.index('status') if 'status' in keys else None
    stage_idx = keys.index('stage') if 'stage' in keys else None
    fill_cache = {}  # hex -> PatternFill, reused across rows sharing a color

    for row in rows:
        fill_hex = None
        if status_idx is not None:
            fill_hex = JO_STATUS_FILL.get(str(row.get('status', '')).lower())
        elif stage_idx is not None:
            fill_hex = APP_STAGE_FILL.get(str(row.get('stage', '')))
        fill = None
        if fill_hex:
            fill = fill_cache.get(fill_hex)
            if fill is None:
                fill = PatternFill('solid', fgColor=fill_hex)
                fill_cache[fill_hex] = fill

        cells = []
        for k in keys:
            c = WriteOnlyCell(ws, value=_xlsx_safe(row.get(k, '')))
            c.font = body_font
            if fill:
                c.fill = fill
            cells.append(c)
        ws.append(cells)

    for i, label in enumerate(labels, start=1):
        ws.column_dimensions[get_column_letter(i)].width = max(12, min(40, len(str(label)) + 6))

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@export_api_bp.route("/export-file", methods=["POST"])
def export_file():
    try:
        body = request.get_json(force=True, silent=True) or {}
        rows = body.get('rows', [])
        columns_in = body.get('columns', [])
        fmt = str(body.get('format', 'csv')).lower()
        if fmt not in ('csv', 'xlsx'):
            fmt = 'csv'
        filename = re.sub(r'[^A-Za-z0-9_-]', '_', str(body.get('filename', 'export'))[:80]) or 'export'

        # Accept either [{key,label}, ...] or a plain list of key strings
        # (falls back to using the key itself as the label).
        keys, labels = [], []
        for c in columns_in:
            if isinstance(c, dict):
                keys.append(c.get('key', ''))
                labels.append(c.get('label', c.get('key', '')))
            else:
                keys.append(c)
                labels.append(c)

        if not keys:
            return {'ok': False, 'error': 'No columns selected'}, 400

        if fmt == 'xlsx':
            data = _build_xlsx_bytes(rows, keys, labels)
            return Response(
                data,
                mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                headers={'Content-Disposition': 'attachment; filename="' + filename + '.xlsx"'},
            )
        else:
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(labels)
            for row in rows:
                writer.writerow([row.get(k, '') for k in keys])
            data = buf.getvalue().encode('utf-8-sig')  # BOM so Excel opens with correct encoding
            return Response(
                data,
                mimetype='text/csv',
                headers={'Content-Disposition': 'attachment; filename="' + filename + '.csv"'},
            )
    except ImportError as e:
        # Names the REAL failure and the exact interpreter running this server —
        # with more than one Python on a machine, "pip install openpyxl" in a
        # different one than the app runs under looks like it did nothing.
        return {'ok': False, 'error': 'XLSX needs openpyxl, which this Python cannot load (%s). '
                'Install it into the interpreter running the app: "%s" -m pip install openpyxl' % (e, sys.executable)}, 500
    except Exception as e:
        return {'ok': False, 'error': str(e)[:160]}, 500

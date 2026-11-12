#!/usr/bin/env python3
"""Reference decoder for 1C .dt dumps (format 3), verified on the real Gʻofurov klinikasi files on 12 Nov 2026.

Port target for task 018 (TypeScript reader in src/modules/import1c). Usage:
    python3 -I scripts/reference/dt_reference.py data/private/<file>.dt
Prints a safe summary only: catalog names, row counts, attribute names, a few service names and prices.
Never prints patients (БЕМОРЛАР), caretakers (Каровчи), staff passwords (ПАРОЛ) or phones.

Format (see docs/1C-BASELINE.md, "Inner format"):
  file = b"1CIBDmpF" + version byte + raw deflate (wbits -15) of a binary bracket stream.
  Each byte: flags 0x20 close-list, 0x80 comma, 0x40 open-list (applied in that order), base tag = byte & 0x1F.
  Base tags: 0x00 nop; 0x01-0x0A digits '0'-'9' (consecutive digits form one number token); 0x0B u8; 0x0C -u8;
  0x0D u16 LE; 0x0E -u16; 0x0F u32 LE; 0x10 -u32; 0x11 i64 LE; 0x15 GUID (16 bytes); 0x16 no-quote flag;
  0x17/0x18/0x19 UTF-16LE string with 1/2/8-byte LE char count; 0x1A/0x1B/0x1C bytes with 1/2/8-byte LE length.
"""
import re, struct, sys, zlib

def inflate(path):
    raw = open(path, 'rb').read()
    if raw[:8] != b'1CIBDmpF': raise ValueError('not a 1C dump')
    return zlib.decompress(raw[9:], -15)

def parse(b):
    root = []; stack = [root]; i = 0; n = len(b); lastdigit = False
    while i < n:
        t = b[i]; i += 1
        if t & 0x20: stack.pop(); lastdigit = False
        if t & 0x80: lastdigit = False
        if t & 0x40:
            nl = []; stack[-1].append(nl); stack.append(nl); lastdigit = False
        base = t & 0x1F; cur = stack[-1]
        if base == 0: continue
        if 1 <= base <= 10:
            d = str(base - 1)
            if lastdigit and cur and isinstance(cur[-1], str): cur[-1] += d
            else: cur.append(d)
            lastdigit = True; continue
        lastdigit = False
        if base == 0x0B: cur.append(b[i]); i += 1
        elif base == 0x0C: cur.append(-b[i]); i += 1
        elif base == 0x0D: cur.append(struct.unpack_from('<H', b, i)[0]); i += 2
        elif base == 0x0E: cur.append(-struct.unpack_from('<H', b, i)[0]); i += 2
        elif base == 0x0F: cur.append(struct.unpack_from('<I', b, i)[0]); i += 4
        elif base == 0x10: cur.append(-struct.unpack_from('<I', b, i)[0]); i += 4
        elif base == 0x11: cur.append(struct.unpack_from('<q', b, i)[0]); i += 8
        elif base == 0x15: cur.append(('guid', b[i:i + 16])); i += 16
        elif base == 0x16: pass
        elif base in (0x17, 0x18, 0x19):
            L = {0x17: 1, 0x18: 2, 0x19: 8}[base]; ln = int.from_bytes(b[i:i + L], 'little'); i += L
            cur.append(b[i:i + 2 * ln].decode('utf-16le')); i += 2 * ln
        elif base in (0x1A, 0x1B, 0x1C):
            L = {0x1A: 1, 0x1B: 2, 0x1C: 8}[base]; ln = int.from_bytes(b[i:i + L], 'little'); i += L
            cur.append(bytes(b[i:i + ln])); i += ln
        else: raise ValueError(f'unknown tag {t:#x} at offset {i - 1}')
    return root

def text(v):
    if isinstance(v, bytes):
        try:
            s = v.decode('ascii')
            if all(32 <= ord(c) < 127 for c in s): return s
        except UnicodeDecodeError: pass
        return None
    return v

def flat(x):
    if isinstance(x, list):
        for y in x: yield from flat(y)
    else: yield x

def folder_files(folder):
    """Top-level entries {'Folder', name, [entries]}; each entry: [.., name(bytes), .., data chunks from index 11]."""
    out = {}
    for e in folder:
        if isinstance(e, list) and len(e) > 11 and isinstance(e[1], bytes):
            blob = b''.join(v for v in flat(e[11:]) if isinstance(v, bytes))
            try: out[e[1].decode()] = zlib.decompress(blob, -15)
            except zlib.error: out[e[1].decode()] = blob
    return out

def load(path):
    top = parse(inflate(path))
    sections = {text(x[1]) if text(x[0]) == 'Folder' else text(x[0]): x for x in top if isinstance(x, list)}
    config = folder_files(sections['Config'][2]); params = folder_files(sections['Params'][2])
    dbnames = [(u, t, int(n)) for u, t, n in re.findall(r'\{([0-9a-f-]{36}),"(\w+)",(\d+)\}', params['DBNames'].decode('utf-8-sig'))]
    database = sections['DataBase'][1]
    return config, dbnames, database

def catalogs(config, dbnames):
    """Reference table -> (1C object name, {FldNN: attribute name}). Object name: '{0,0,<uuid>},"NAME"'; attributes: '<uuid>},"NAME",{1,"ru"'."""
    fld = {u: n for u, t, n in dbnames if t == 'Fld'}; res = {}
    for u, t, n in dbnames:
        if t != 'Reference' or u not in config: continue
        txt = config[u].decode('utf-8-sig', 'replace')
        m = re.search(r'\{0,0,' + u + r'\},"([^"]+)"', txt) or re.search(r'"([А-ЯЁЎҚҒҲа-яёўқғҳA-Za-z_][^"]{1,60})"', txt)
        attrs = {f'Fld{fld[a]}': name for a, name in re.findall(r'([0-9a-f-]{36})\},"([^"]+)",\s*\{1,"ru"', txt) if a in fld}
        res[f'Reference{n}'] = (m.group(1) if m else None, attrs)
    return res

def table_order(database):
    """DataBase[0] = ['0', [count, table descriptors...]]; data lists follow in schema order, each table followed by its subtables."""
    order = []
    for t in database[0][1][1:]:
        order.append((text(t[0]), t))
        if isinstance(t[5], list):
            for st in t[5][1:]:
                if isinstance(st, list): order.append((f'{text(t[0])}.{text(st[0])}', st))
    return order

def table_rows(database, order, table):
    """Rows are flat [flag, value, ...]; flag '1' = value follows, '0' = NULL. Fields of type V (86, record version) are not stored."""
    for j, (name, t) in enumerate(order):
        if name != table: continue
        fields = [text(f[0]) for f in t[4][1:] if f[2][1][0] != 86]
        out = []
        for row in database[1 + j][1:]:
            vals = []; k = 0
            while k < len(row):
                flag = row[k]; k += 1
                if flag in ('1', 1): vals.append(row[k]); k += 1
                else: vals.append(None)
            out.append(dict(zip(fields, vals)))
        return out
    return []

SKIP = {'БЕМОРЛАР', 'Каровчи'}           # never decode values
SECRET_ATTRS = {'ПАРОЛ', 'Телефон'}     # never print

if __name__ == '__main__':
    config, dbnames, database = load(sys.argv[1]); order = table_order(database)
    for table, (name, attrs) in catalogs(config, dbnames).items():
        if name is None or name in SKIP: print(f'{table} {name}: skipped'); continue
        rows = table_rows(database, order, table)
        items = [r for r in rows if r.get('Folder') != '0']
        shown = {k: v for k, v in attrs.items() if v not in SECRET_ATTRS}
        print(f'{table} {name}: rows {len(rows)}, items {len(items)}, attributes {shown}')
        if name in ('МУОЛАЖА', 'Анализ'):
            price = next((k for k, v in attrs.items() if v in ('НАРХИ', 'Цена')), None)
            for r in items[:3]: print('   ', r.get('Description'), '|', r.get(price))

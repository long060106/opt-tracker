"""
Synthetic test documents for the document reader: fake I-94 printouts and I-797C
receipt notices modelled on the real layouts, plus photo/scan-style degradations.
Every name, number and date in here is invented.

    python tests/fixtures/make_fixtures.py          # writes tests/fixtures/out/

Requires Pillow. Output is git-ignored; regenerate it whenever you need it.
"""
import io
import json
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out')
W, H = 1700, 2200  # US Letter at 200 dpi

FONT_DIRS = ['C:/Windows/Fonts', '/usr/share/fonts/truetype/msttcorefonts',
             '/usr/share/fonts/truetype/liberation', '/Library/Fonts',
             '/System/Library/Fonts/Supplemental']
FACES = {
    'sans': ['arial.ttf', 'Arial.ttf', 'LiberationSans-Regular.ttf'],
    'sans-bold': ['arialbd.ttf', 'Arial Bold.ttf', 'LiberationSans-Bold.ttf'],
    'serif': ['times.ttf', 'Times New Roman.ttf', 'LiberationSerif-Regular.ttf'],
    'serif-bold': ['timesbd.ttf', 'Times New Roman Bold.ttf', 'LiberationSerif-Bold.ttf'],
}
_fonts = {}


def font(face, px):
    key = (face, int(px))
    if key in _fonts:
        return _fonts[key]
    for d in FONT_DIRS:
        for name in FACES[face]:
            path = os.path.join(d, name)
            if os.path.exists(path):
                _fonts[key] = ImageFont.truetype(path, int(px))
                return _fonts[key]
    raise SystemExit('No usable font for %s; install Arial/Times or Liberation fonts.' % face)


def wrap(draw, text, fnt, width):
    lines, line = [], ''
    for word in text.split():
        trial = (line + ' ' + word).strip()
        if draw.textlength(trial, font=fnt) > width and line:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    return lines


# --------------------------------------------------------------------------- documents

def i797c(spec):
    im = Image.new('L', (W, H), 255)
    g = ImageDraw.Draw(im)

    def s(v):
        return int(round(v * W / 786.0))

    line = max(2, s(1))
    g.text((s(38), s(6)), 'Department of Homeland Security', font=font('serif-bold', s(12.5)), fill=0)
    g.text((s(38), s(21)), 'U.S. Citizenship and Immigration Services', font=font('serif', s(11.5)), fill=0)
    g.text((s(510), s(9)), 'Form I-797C, Notice of Action', font=font('serif-bold', s(17)), fill=0)
    g.rectangle([s(36), s(36), s(748), s(41)], fill=0)
    g.rectangle([s(38), s(49), s(750), s(76)], outline=0, width=line)
    g.text((s(45), s(52)), 'THIS NOTICE DOES NOT GRANT ANY IMMIGRATION STATUS OR BENEFIT.',
           font=font('serif-bold', s(16.5)), fill=0)

    left, mid, right, end = s(14), s(250), s(533), s(722)
    rows = [s(97), s(126), s(153), s(181), s(207)]
    g.rectangle([left, rows[0], end, s(870)], outline=0, width=line)
    for y in rows[1:]:
        g.line([left, y, end, y], fill=0, width=line)
    g.line([right, rows[0], right, rows[4]], fill=0, width=line)
    g.line([mid, rows[2], mid, rows[4]], fill=0, width=line)
    g.line([left, s(357), end, s(357)], fill=0, width=line)
    g.line([s(490), rows[4], s(490), s(357)], fill=0, width=line)

    lab = font('sans-bold', s(6.3))
    val = font('serif', s(11.5))
    cells = [
        (left, 0, 'NOTICE TYPE', 'Receipt'),
        (right, 0, 'NOTICE DATE', spec['notice']),
        (left, 1, 'CASE TYPE', spec['case']),
        (right, 1, 'USCIS ALIEN NUMBER', 'A 212-345-678'),
        (left, 2, 'RECEIPT NUMBER', 'IOE0931234567'),
        (mid, 2, 'RECEIVED DATE', spec['received']),
        (right, 2, 'PAGE', '1 of 1'),
        (left, 3, 'PRIORITY DATE', ''),
        (mid, 3, 'ELIGIBILITY CLASSIFICATION', spec.get('eligibility', '')),
        (right, 3, 'DATE OF BIRTH', spec['dob']),
    ]
    for x, row, label, value in cells:
        g.text((x + s(4), rows[row] + s(1.5)), label, font=lab, fill=0)
        if value:
            g.text((x + s(6), rows[row] + s(11)), value, font=val, fill=0)

    small = font('sans', s(8.5))
    for i, t in enumerate(['JANE Q SAMPLE', '1234 EXAMPLE AVE APT 5', 'SPRINGFIELD, IL 62704']):
        g.text((s(129), s(232) + i * s(11)), t, font=small, fill=0)
    g.text((s(498), s(212)), 'PAYMENT INFORMATION:', font=font('serif-bold', s(9.5)), fill=0)
    for i, (a, b) in enumerate([('Application/Petition Fee:', '$470.00'),
                                ('Total Amount Received:', '$470.00'),
                                ('Total Balance Due:', '$0.00')]):
        g.text((s(498), s(232) + i * s(15)), a, font=font('serif-bold', s(8.5)), fill=0)
        g.text((s(628), s(232) + i * s(15)), b, font=font('serif', s(8.5)), fill=0)
    g.text((s(122), s(344)), 'APPLICANT/PETITIONER NAME AND MAILING ADDRESS', font=font('serif-bold', s(8)), fill=0)

    body = font('serif', s(11))
    y = s(390)
    for para in [
        'We have received your form and are currently processing the above case. If any of the above '
        'information is incorrect, please visit our website.',
        'If this notice contains a priority date, this priority does not reflect earlier retained priority dates.',
        'If we determine you must submit biometrics, we will mail you a biometrics appointment notice with '
        'the time and place of your appointment.',
        'If you have questions or need to update your personal information listed above, please visit the '
        'USCIS Contact Center webpage at uscis.gov/contactcenter.',
    ]:
        for ln in wrap(g, para, body, s(690)):
            g.text((s(24), y), ln, font=body, fill=0)
            y += s(14)
        y += s(12)

    g.text((s(20), s(885)), 'USCIS Office Address:', font=font('serif-bold', s(11)), fill=0)
    for i, t in enumerate(['USCIS', 'National Benefits Center', 'P.O. Box 648003', "Lee's Summit, MO 64002"]):
        g.text((s(20), s(905) + i * s(15)), t, font=font('serif', s(11)), fill=0)
    g.text((s(444), s(885)), 'USCIS Contact Center Number:', font=font('serif-bold', s(11)), fill=0)
    g.text((s(444), s(905)), '(800)375-5283', font=font('serif', s(11)), fill=0)
    g.text((s(646), s(1003)), 'Form I-797C 10/13/21', font=font('serif', s(8)), fill=0)
    return im


def i94(spec):
    im = Image.new('L', (W, H), 255)
    g = ImageDraw.Draw(im)

    def s(v):
        return int(round(v * W / 2120.0))

    g.text((s(270), s(180)), 'For: JANE Q SAMPLE', font=font('sans-bold', s(46)), fill=0)
    g.rectangle([s(270), s(380), s(2000), s(530)], fill=110)
    g.text((s(470), s(400)), 'U.S. Customs and Border Protection', font=font('sans', s(60)), fill=255)
    g.text((s(470), s(478)), "Securing America's Borders", font=font('sans-bold', s(30)), fill=235)
    g.text((s(372), s(655)), 'Most Recent I-94', font=font('sans-bold', s(40)), fill=0)
    g.line([s(372), s(715), s(2000), s(715)], fill=0, width=s(4))

    bold = font('sans-bold', s(34))
    rows = ['Admission (I-94) Record Number : 123456789A1',
            'Most Recent Date of Entry: ' + spec['entry'],
            'Class of Admission : F1',
            'Admit Until Date : ' + spec['until'],
            'Details provided on the I-94 Information form:']
    for i, t in enumerate(rows):
        g.text((s(374), s(824) + i * s(62)), t, font=bold, fill=0)
    table = [('Last/Surname :', 'SAMPLE'), ('First (Given) Name :', 'JANE Q'),
             ('Birth Date :', spec['birth']), ('Document Number :', 'X1234567'),
             ('Country of Citizenship :', 'Vietnam')]
    for i, (a, v) in enumerate(table):
        y = s(1195) + i * s(60)
        g.text((s(374), y), a, font=bold, fill=0)
        g.text((s(780), y), v, font=bold, fill=0)
    g.rectangle([s(990), s(1540), s(1280), s(1600)], outline=0, width=s(3))
    g.text((s(1010), s(1552)), 'Get Travel History', font=font('sans', s(30)), fill=0)

    small = font('sans-bold', s(24))
    y = s(1670)
    for para in [
        'Effective April 26, 2013, DHS began automating the admission process. An alien lawfully admitted or '
        'paroled into the U.S. is no longer required to be in possession of a preprinted Form I-94.',
        'If an employer, local, state or federal agency requests admission information, present your admission '
        '(I-94) number along with any additional required documents requested by that employer or agency.',
    ]:
        for ln in wrap(g, para, small, s(1600)):
            g.text((s(355), y), ln, font=small, fill=0)
            y += s(38)
        y += s(40)
    return im


def invoice(spec):
    im = Image.new('L', (W, H), 255)
    g = ImageDraw.Draw(im)
    g.text((140, 140), 'ACME STORAGE CO.', font=font('sans-bold', 64), fill=0)
    g.text((140, 230), 'Unit rental invoice', font=font('sans', 40), fill=0)
    fnt = font('sans', 36)
    lines = ['Invoice Number: 2026-0412', 'Notice Date: March 20, 2026', 'Received Date: 03/04/2026',
             'Due Date: April 15, 2026', 'Customer: Jane Sample', 'Unit: B-17 (10 x 10)', 'Amount due: $184.00']
    for i, t in enumerate(lines):
        g.text((140, 380 + i * 70), t, font=fnt, fill=0)
    for i, ln in enumerate(wrap(g, 'Thank you for storing with us. Payments received after the due date are '
                                   'subject to a late fee. Questions? Call the front office.', fnt, 1400)):
        g.text((140, 950 + i * 56), ln, font=fnt, fill=0)
    return im


# --------------------------------------------------------------------------- degradations

def solve_perspective(src, dst):
    # Coefficients mapping output (dst) points back to input (src) points, for Image.PERSPECTIVE.
    rows, rhs = [], []
    for (x, y), (u, v) in zip(dst, src):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        rhs.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        rhs.append(v)
    n = 8
    a = [rows[i] + [rhs[i]] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(a[r][c]))
        a[c], a[p] = a[p], a[c]
        for r in range(n):
            if r != c:
                f = a[r][c] / a[c][c]
                a[r] = [a[r][k] - f * a[c][k] for k in range(n + 1)]
    return [a[i][n] / a[i][i] for i in range(n)]


def paper(im):
    return Image.merge('RGB', [im.point(lambda p, k=k: int(p * k / 255)) for k in (246, 242, 232)])


def v_clean(im, rnd):
    return im, 'png'


def v_lowres(im, rnd):
    return im.resize((int(W * 0.46), int(H * 0.46)), Image.LANCZOS), 'png'


def v_fax(im, rnd):
    small = im.resize((int(W * 0.75), int(H * 0.75)), Image.LANCZOS)
    bw = small.point(lambda p: 255 if p > 150 else 0)
    px = bw.load()
    w, h = bw.size
    for _ in range(int(w * h * 0.003)):
        x, y = rnd.randrange(w), rnd.randrange(h)
        px[x, y] = 0 if px[x, y] else 255
    return bw, 'png'


def _photo(im, rnd, quarter):
    desk = (70, 62, 55)
    rot = paper(im).rotate(3.2, resample=Image.BICUBIC, expand=True, fillcolor=desk)
    canvas = Image.new('RGB', (rot.width + 240, rot.height + 240), desk)
    canvas.paste(rot, (120, 120))
    grad = Image.linear_gradient('L').resize(canvas.size).rotate(35)
    shade = grad.point(lambda p: int(255 - p * 0.35))
    canvas = ImageChops.multiply(canvas, Image.merge('RGB', [shade] * 3))
    canvas = canvas.filter(ImageFilter.GaussianBlur(1.1))
    noise = Image.effect_noise(canvas.size, 10).convert('L')
    canvas = ImageChops.add(canvas, Image.merge('RGB', [noise] * 3), 1.0, -128)
    if quarter:
        canvas = canvas.rotate(-90 * quarter, expand=True)
    return canvas, 'jpg'


def v_photo(im, rnd):
    return _photo(im, rnd, 0)


def v_photo_rot90(im, rnd):
    return _photo(im, rnd, 1)


def v_perspective(im, rnd):
    src = [(0, 0), (W, 0), (W, H), (0, H)]
    dst = [(60, 40), (W - 20, 90), (W - 90, H - 30), (30, H - 70)]
    out = paper(im).transform((W, H), Image.PERSPECTIVE, solve_perspective(src, dst), Image.BICUBIC,
                              fillcolor=(80, 80, 80))
    return out.filter(ImageFilter.GaussianBlur(0.8)), 'jpg'


def v_dim(im, rnd):
    low = im.point(lambda p: int(95 + p * 0.5)).filter(ImageFilter.GaussianBlur(0.6))
    return low.resize((int(W * 0.6), int(H * 0.6)), Image.LANCZOS), 'jpg-low'


VARIANTS = [('clean', v_clean), ('lowres', v_lowres), ('fax', v_fax), ('photo', v_photo),
            ('photo-rot90', v_photo_rot90), ('perspective', v_perspective), ('dim', v_dim)]


# --------------------------------------------------------------------------- PDFs

def pdf_document(objects):
    out = io.BytesIO()
    out.write(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b'%d 0 obj\n' % i)
        out.write(body)
        out.write(b'\nendobj\n')
    xref = out.tell()
    out.write(b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1))
    for off in offsets:
        out.write(b'%010d 00000 n \n' % off)
    out.write(b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref))
    return out.getvalue()


def stream(dictionary, data):
    return b'<< ' + dictionary + b' /Length %d >>\nstream\n' % len(data) + data + b'\nendstream'


def image_pdf(img):
    buf = io.BytesIO()
    gray = img.mode == 'L'
    img.save(buf, 'JPEG', quality=80)
    jpeg = buf.getvalue()
    content = b'q 612 0 0 792 0 0 cm /Im0 Do Q'
    return pdf_document([
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> '
        b'/Contents 5 0 R >>',
        stream(b'/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /%s /BitsPerComponent 8 '
               b'/Filter /DCTDecode' % (img.width, img.height, b'DeviceGray' if gray else b'DeviceRGB'), jpeg),
        stream(b'', content),
    ])


def text_pdf(lines):
    def esc(t):
        return t.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)').encode('latin-1')
    ops = []
    for x, y_top, size, text, bold in lines:
        ops.append(b'BT /%s %d Tf %.1f %.1f Td (%s) Tj ET' % (b'F2' if bold else b'F1', size, x, 792 - y_top,
                                                            esc(text)))
    return pdf_document([
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> '
        b'/Contents 6 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
        stream(b'', b'\n'.join(ops)),
    ])


def i94_text_pdf(spec):
    k = 612 / 2120.0
    lines = [(270 * k, 225 * k, 13, 'For: JANE Q SAMPLE', True),
             (470 * k, 460 * k, 17, 'U.S. Customs and Border Protection', False),
             (372 * k, 700 * k, 12, 'Most Recent I-94', True)]
    rows = ['Admission (I-94) Record Number : 123456789A1', 'Most Recent Date of Entry: ' + spec['entry'],
            'Class of Admission : F1', 'Admit Until Date : ' + spec['until'],
            'Details provided on the I-94 Information form:']
    for i, t in enumerate(rows):
        lines.append((374 * k, (860 + i * 62) * k, 10, t, True))
    for i, (a, v) in enumerate([('Last/Surname :', 'SAMPLE'), ('First (Given) Name :', 'JANE Q'),
                                ('Birth Date :', spec['birth']), ('Document Number :', 'X1234567')]):
        lines.append((374 * k, (1230 + i * 60) * k, 10, a, True))
        lines.append((780 * k, (1230 + i * 60) * k, 10, v, True))
    return text_pdf(lines)


# --------------------------------------------------------------------------- manifest

DOCS = [
    ('i94-fixed-numeric', i94, dict(entry='2026 August 20', until='09/15/2028', birth='1999 November 02'),
     {'doc': 'i94', 'i94Expiration': '2028-09-15'}),
    ('i94-fixed-words', i94, dict(entry='2026 January 05', until='2029 January 31', birth='2000 March 14'),
     {'doc': 'i94', 'i94Expiration': '2029-01-31'}),
    ('i94-ds', i94, dict(entry='2022 June 04', until='D/S', birth='1999 November 02'),
     {'doc': 'i94', 'ds': True}),
    ('i797-i765-words', i797c, dict(notice='March 20, 2026', received='March 12, 2026', dob='May 3, 1999',
                                    case='I-765, Application for Employment Authorization',
                                    eligibility='(c)(3)(B)'),
     {'doc': 'i797', 'filedDate': '2026-03-12', 'caseType': 'I-765'}),
    ('i797-i765-numeric', i797c, dict(notice='01/15/2026', received='01/09/2026', dob='11/30/1998',
                                      case='I765 - APPLICATION FOR EMPLOYMENT AUTHORIZATION', eligibility='C03C'),
     {'doc': 'i797', 'filedDate': '2026-01-09', 'caseType': 'I-765'}),
    ('i797-i539', i797c, dict(notice='June 9, 2026', received='June 2, 2026', dob='May 3, 1999',
                              case='I-539, Application To Extend/Change Nonimmigrant Status'),
     {'doc': 'i797', 'filedDate': None, 'caseType': 'I-539'}),
    ('invoice', invoice, {}, {'doc': None}),
]


def save(img, path, kind):
    if kind == 'png':
        img.save(path + '.png')
        return path + '.png'
    quality = 45 if kind == 'jpg-low' else 62
    img.convert('RGB').save(path + '.jpg', 'JPEG', quality=quality)
    return path + '.jpg'


def main():
    os.makedirs(OUT, exist_ok=True)
    rnd = random.Random(20260914)
    manifest = []
    bases = {}
    for name, draw, spec, expect in DOCS:
        base = draw(spec)
        bases[name] = base
        for variant, fn in VARIANTS:
            img, kind = fn(base, rnd)
            path = save(img, os.path.join(OUT, '%s--%s' % (name, variant)), kind)
            manifest.append({'file': os.path.basename(path), 'doc': name, 'variant': variant, 'expect': expect})

    pdfs = [
        ('i94-fixed-numeric--digital.pdf', i94_text_pdf(DOCS[0][2]), DOCS[0][3], 'digital-pdf'),
        ('i797-i765-words--scan.pdf', image_pdf(bases['i797-i765-words']), DOCS[3][3], 'scan-pdf'),
        ('i94-fixed-words--photo.pdf', image_pdf(_photo(bases['i94-fixed-words'], rnd, 0)[0]), DOCS[1][3],
         'photo-pdf'),
        ('i797-i539--scan.pdf', image_pdf(bases['i797-i539']), DOCS[5][3], 'scan-pdf'),
    ]
    for filename, data, expect, variant in pdfs:
        with open(os.path.join(OUT, filename), 'wb') as fh:
            fh.write(data)
        manifest.append({'file': filename, 'doc': filename.split('--')[0], 'variant': variant, 'expect': expect})

    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1)
    print('wrote %d fixtures to %s' % (len(manifest), OUT))


if __name__ == '__main__':
    main()

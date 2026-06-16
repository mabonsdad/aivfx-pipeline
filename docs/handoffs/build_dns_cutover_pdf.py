from pathlib import Path
import textwrap

OUT = Path('/Users/robinmoore/aivfx-pipeline/docs/handoffs/aivfx-weekend-dns-cutover-plan.pdf')
TITLE = 'AIVFX Weekend DNS Cutover Plan'

sections = [
    ('Purpose', [
        'This handoff covers the weekend DNS cutover needed to make aivfx.shwsh.co.uk live from the Route53 hosted zone you can currently edit.',
        'Do not attempt this mid-week if you cannot tolerate temporary mail or site disruption. The domain currently appears to be delegated to an older Route53 zone, while your editable public zone uses a different Route53 delegation set.'
    ]),
    ('Recommendation 1: Fix the zone apex NS record inside the current Route53 zone', [
        'In hosted zone ZHPU4DS4ZT4ZY, replace the apex NS record for shwsh.co.uk so it matches the hosted zone\'s actual assigned nameservers.',
        'Target nameservers:',
        'ns-750.awsdns-29.net',
        'ns-104.awsdns-13.com',
        'ns-1460.awsdns-54.org',
        'ns-1759.awsdns-27.co.uk',
        'This does not switch public traffic by itself. It only makes the hosted zone internally consistent before registrar delegation is changed.'
    ]),
    ('Exact CLI for Recommendation 1', [
        'aws route53 change-resource-record-sets --hosted-zone-id ZHPU4DS4ZT4ZY --change-batch \"{',
        '  \'Comment\': \'Replace apex NS record with hosted zone delegation set\',',
        '  \'Changes\': [',
        '    {',
        '      \'Action\': \'UPSERT\',',
        '      \'ResourceRecordSet\': {',
        '        \'Name\': \'shwsh.co.uk.\',',
        '        \'Type\': \'NS\',',
        '        \'TTL\': 172800,',
        '        \'ResourceRecords\': [',
        '          { \'Value\': \'ns-750.awsdns-29.net.\' },',
        '          { \'Value\': \'ns-104.awsdns-13.com.\' },',
        '          { \'Value\': \'ns-1460.awsdns-54.org.\' },',
        '          { \'Value\': \'ns-1759.awsdns-27.co.uk.\' }',
        '        ]',
        '      }',
        '    }',
        '  ]',
        '}\"',
    ]),
    ('Recommendation 2: Change the registrar delegation at Gandi', [
        'At the registrar, change the domain nameservers for shwsh.co.uk to the same four nameservers used by the hosted zone:',
        'ns-750.awsdns-29.net',
        'ns-104.awsdns-13.com',
        'ns-1460.awsdns-54.org',
        'ns-1759.awsdns-27.co.uk',
        'This is the actual public cutover step. Once Gandi points the domain at these nameservers, the records in hosted zone ZHPU4DS4ZT4ZY become authoritative for the internet.'
    ]),
    ('Gandi change checklist', [
        'Before saving the nameserver change, verify the hosted zone still contains at least these production records: apex A alias, www A alias, MX, SPF TXT, DKIM CNAME records, blog A, oldblog A, aivfx CNAME, and any validation records you still rely on.',
        'Because email is critical, verify mail delivery after cutover by sending inbound and outbound tests.'
    ]),
    ('Recommendation 3: Weekend cutover verification checklist', [
        'Run these checks in order after changing the registrar nameservers.',
        '1. Confirm public delegation:',
        '   dig shwsh.co.uk NS +short',
        '   Expected: ns-750.awsdns-29.net, ns-104.awsdns-13.com, ns-1460.awsdns-54.org, ns-1759.awsdns-27.co.uk',
        '2. Confirm root site still resolves:',
        '   nslookup shwsh.co.uk 8.8.8.8',
        '   nslookup www.shwsh.co.uk 8.8.8.8',
        '3. Confirm the new app subdomain resolves:',
        '   nslookup aivfx.shwsh.co.uk 8.8.8.8',
        '   nslookup aivfx.shwsh.co.uk 1.1.1.1',
        '4. Confirm mail records:',
        '   dig shwsh.co.uk MX +short',
        '   dig shwsh.co.uk TXT +short',
        '   dig fm1._domainkey.shwsh.co.uk CNAME +short',
        '5. Test websites in browser:',
        '   https://shwsh.co.uk/',
        '   https://www.shwsh.co.uk/',
        '   https://aivfx.shwsh.co.uk/',
        '6. Test Cognito login and logout on the new subdomain.',
        '7. Send and receive at least one real email through the domain.'
    ]),
    ('Expected timing', [
        'A registrar nameserver change is not the same as an ordinary Route53 record edit. Several hours is plausible; up to 24 to 48 hours is a safe worst-case expectation for full propagation through all recursive resolvers.',
        'Temporary resolver disagreement is normal during that window. The key signal is the NS delegation gradually changing to the new Route53 nameserver set.'
    ]),
    ('Rollback position', [
        'If the cutover goes badly, the rollback is to restore the old nameserver set at Gandi.',
        'Old delegated nameservers observed publicly before cutover:',
        'ns-1196.awsdns-21.org',
        'ns-551.awsdns-04.net',
        'ns-418.awsdns-52.com',
        'ns-1610.awsdns-09.co.uk',
        'Only use rollback if the new zone is clearly missing a critical production record or mail flow breaks.'
    ]),
    ('Post-cutover note', [
        'Once aivfx.shwsh.co.uk is live, the frontend prod/dev URL split is complete for Phase 1.',
        'Backend, API, Cognito client, worker, assets bucket, and metadata bucket are still shared until the later production environment split.'
    ]),
]

# PDF generation helpers
PAGE_WIDTH = 595
PAGE_HEIGHT = 842
LEFT = 54
RIGHT = 54
TOP = 58
BOTTOM = 58
LINE_HEIGHT = 15
FONT_SIZE = 11
TITLE_SIZE = 18
SECTION_SIZE = 13
MAX_COLS = 88

lines = []
lines.append(('title', TITLE))
for heading, paras in sections:
    lines.append(('space', ''))
    lines.append(('section', heading))
    for para in paras:
        if para.endswith(':') and not para.startswith('   '):
            lines.append(('sub', para))
            continue
        if para.startswith('   '):
            wrapped = textwrap.wrap(para, width=MAX_COLS-4, subsequent_indent='    ', break_long_words=False)
            for w in wrapped:
                lines.append(('body', w))
            continue
        wrapped = textwrap.wrap(para, width=MAX_COLS, break_long_words=False)
        if not wrapped:
            lines.append(('body', ''))
        for w in wrapped:
            lines.append(('body', w))

pages = []
current = []
y = PAGE_HEIGHT - TOP

def consume_height(kind):
    if kind == 'title':
        return 26
    if kind == 'section':
        return 20
    if kind == 'sub':
        return 17
    if kind == 'space':
        return 8
    return LINE_HEIGHT

for item in lines:
    needed = consume_height(item[0])
    if y - needed < BOTTOM:
        pages.append(current)
        current = []
        y = PAGE_HEIGHT - TOP
    current.append((item, y))
    y -= needed
if current:
    pages.append(current)

objects = []

def esc(text):
    return text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')

font_obj_num = 1
page_obj_nums = []
content_obj_nums = []
page_count = len(pages)
next_obj = 2
pages_obj_num = 2 + page_count * 2
catalog_obj_num = pages_obj_num + 1

for i in range(page_count):
    page_obj_nums.append(next_obj)
    content_obj_nums.append(next_obj + 1)
    next_obj += 2

# Font object
objects.append((font_obj_num, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))

for idx, page in enumerate(pages):
    content_lines = ['BT']
    for (kind, text), ypos in page:
        if kind == 'title':
            content_lines.append(f'/F1 {TITLE_SIZE} Tf')
            content_lines.append(f'1 0 0 1 {LEFT} {ypos} Tm ({esc(text)}) Tj')
        elif kind == 'section':
            content_lines.append(f'/F1 {SECTION_SIZE} Tf')
            content_lines.append(f'1 0 0 1 {LEFT} {ypos} Tm ({esc(text)}) Tj')
        elif kind == 'sub':
            content_lines.append(f'/F1 {FONT_SIZE} Tf')
            content_lines.append(f'1 0 0 1 {LEFT} {ypos} Tm ({esc(text)}) Tj')
        elif kind == 'body':
            content_lines.append(f'/F1 {FONT_SIZE} Tf')
            content_lines.append(f'1 0 0 1 {LEFT} {ypos} Tm ({esc(text)}) Tj')
    footer = f'Page {idx + 1} of {page_count}'
    content_lines.append(f'/F1 9 Tf')
    content_lines.append(f'1 0 0 1 {LEFT} 28 Tm ({esc(footer)}) Tj')
    content_lines.append('ET')
    stream = '\n'.join(content_lines).encode('latin-1', 'replace')
    content = f'<< /Length {len(stream)} >>\nstream\n'.encode('ascii') + stream + b'\nendstream'
    objects.append((content_obj_nums[idx], content))
    page_dict = (
        f'<< /Type /Page /Parent {pages_obj_num} 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] '
        f'/Resources << /Font << /F1 {font_obj_num} 0 R >> >> /Contents {content_obj_nums[idx]} 0 R >>'
    )
    objects.append((page_obj_nums[idx], page_dict))

kids = ' '.join(f'{n} 0 R' for n in page_obj_nums)
objects.append((pages_obj_num, f'<< /Type /Pages /Kids [ {kids} ] /Count {page_count} >>'))
objects.append((catalog_obj_num, f'<< /Type /Catalog /Pages {pages_obj_num} 0 R >>'))
objects.sort(key=lambda x: x[0])

pdf = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
offsets = {0: 0}
for num, body in objects:
    offsets[num] = len(pdf)
    pdf.extend(f'{num} 0 obj\n'.encode('ascii'))
    if isinstance(body, str):
        pdf.extend(body.encode('latin-1'))
    else:
        pdf.extend(body)
    pdf.extend(b'\nendobj\n')

xref_start = len(pdf)
max_obj = max(offsets)
pdf.extend(f'xref\n0 {max_obj + 1}\n'.encode('ascii'))
pdf.extend(b'0000000000 65535 f \n')
for i in range(1, max_obj + 1):
    pdf.extend(f'{offsets[i]:010d} 00000 n \n'.encode('ascii'))
pdf.extend(f'trailer\n<< /Size {max_obj + 1} /Root {catalog_obj_num} 0 R >>\nstartxref\n{xref_start}\n%%EOF\n'.encode('ascii'))

OUT.write_bytes(pdf)
print(OUT)
print(f'pages={page_count} bytes={OUT.stat().st_size}')

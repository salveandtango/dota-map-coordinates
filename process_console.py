import json
import os
import re

def all_int(l):
    try:
        for k in l:
            int(k)
        return True
    except:
        return False

# Pattern to match VScript console output prefix (only strip one space after :])
vscript_prefix = re.compile(r'^\[\s*VScript\s*\]: ')

def strip_prefix(line):
    """Strip the VScript console prefix if present"""
    match = vscript_prefix.match(line)
    if match:
        return line[match.end():]
    return line

with open('datav2/current_version.log', 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()
    started = False
    next_filename = False
    data = {}
    curr_tbl = data
    curr_key = None
    stack = []
    level = -1
    for line in lines:
        line = line.rstrip('\n')
        line = strip_prefix(line)  # Strip VScript prefix
        if line == '[start]':
            started = True
            next_filename = True
            data = {}
            curr_tbl = data
            curr_key = None
            stack = []
            level = -1
            print(line)
        elif next_filename:
            print(line)
            filename = line
            next_filename = False
        elif line == '[end]':
            print(line)
            started = False
            while len(stack):
##                print(all_int(curr_tbl.keys()))
                tbl, key = stack.pop()
                if all_int(curr_tbl.keys()):
                    tbl[key] = list(curr_tbl.values())
##                    print(tbl[key])
                curr_tbl = tbl
            with open(os.path.join('datav2', filename), 'w') as g:
                g.write(json.dumps(data, separators=(',', ':')))
        elif started:
            line_level = (len(line) - len(line.lstrip())) / 2
            parts = line.split(':', 1)  # Split only on first colon
            if len(parts) != 2:
                continue  # Skip malformed lines
            k, v = [x.strip() for x in parts]
##            print(line_level, k, v)
            while level > line_level:
##                print(all_int(curr_tbl.keys()))
                tbl, key = stack.pop()
                if all_int(curr_tbl.keys()):
                    tbl[key] = list(curr_tbl.values())
##                    print(tbl[key])
                curr_tbl = tbl
                level -= 1
            if v == '':
##                print ('New', k.isdigit())
                curr_tbl[k] = {}
                stack.append((curr_tbl, k))
                curr_tbl = curr_tbl[k]
            else:
                try:
                    curr_tbl[k] = int(v)
                except:
                    try:
                        curr_tbl[k] = float(v)
                    except:
                        curr_tbl[k] = v
            level = line_level

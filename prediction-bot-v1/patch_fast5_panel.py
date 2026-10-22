#!/usr/bin/env python3
"""Remove legacy model-performance UI from the prediction control proxy."""
from pathlib import Path
import sys
original,target=map(Path,sys.argv[1:3])
s=original.read_text()
a=s.index('const statsCard = `')
b=s.index('let child = null;',a)
assert b>a and s.count('function injectStats(html) {')==1
s=s[:a]+"""// Use the original order-control page without training and accuracy overlays.
function injectStats(html) { return html; }

"""+s[b:]
assert 'learningEvidenceCard' not in s
assert 'roundStatsCard' not in s
target.write_text(s)
print('NO_LEARNING_PERFORMANCE_CARDS_IN_PREDICTION_PANEL=true')

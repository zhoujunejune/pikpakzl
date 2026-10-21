#!/usr/bin/env python3
"""Add a visible read-only Learning Effect anchor near the top of prediction control UI."""
from pathlib import Path
import sys
assert len(sys.argv)==3
source=Path(sys.argv[1]).read_text()
assert 'id="learningEvidenceCard"' in source, 'LEARNING_PANEL_NOT_PRESENT'
anchor="  out = out.replace('</head>', layoutStabilityStyle+'</head>');"
assert source.count(anchor)==1,'INJECTOR_ANCHOR_UNKNOWN'
assert 'AI学习效果 · 查看历史经验与错误复盘' not in source,'NAV_ALREADY_PRESENT'
extra="""  // This link appears above the trading controls; it only scrolls to a read-only card.
  out = out.replace('<h2>5分钟 API 实盘确认控制台</h2>',
    '<h2>5分钟 API 实盘确认控制台</h2><div class="c" style="border:1px solid #40536b"><a href="#learningEvidenceCard" style="display:block;color:#86c5ff;font-weight:700;font-size:17px;text-decoration:underline;padding:4px 0">AI学习效果 · 查看历史经验与错误复盘 ↓</a><div class="muted">只读统计，不会操作开始跟随或改变25秒预测策略。</div></div>');
"""
source=source.replace(anchor,anchor+'\n'+extra)
assert source.count("href=\"#learningEvidenceCard\"")==1
assert "var expired=Date.now()>=currentRound+25000;" in source
Path(sys.argv[2]).write_text(source)
print('LEARNING_TOP_NAV_PATCH_READY=true')

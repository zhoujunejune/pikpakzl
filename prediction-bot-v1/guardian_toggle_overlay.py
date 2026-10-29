#!/usr/bin/env python3
"""Apply only verified upstream GUARDIAN-switch hunks to advanced production code.
Never copy the older GitHub control-shell/risk-runner over unrelated live changes.
"""
from __future__ import annotations
import difflib
from pathlib import Path

FILES = (
    'control-shell.mjs',
    'risk-config-storage.mjs',
    'risk-runner.mjs',
)

def overlay(base: str, updated: str, live: str, filename: str) -> str:
    if filename not in FILES:
        raise ValueError('FILE_NOT_WHITELISTED')
    if live == updated:
        return live
    markers = {
        'control-shell.mjs': 'function guardianRiskToggleStatus(now=Date.now())',
        'risk-config-storage.mjs': 'guardianDynamicEnabled: value.guardianDynamicEnabled === true',
        'risk-runner.mjs': 'function guardianOpenExposure(now=Date.now())',
    }
    if markers[filename] in live:
        raise ValueError('PARTIAL_OR_ALREADY_PATCHED_ABORT')
    aa = base.splitlines(keepends=True)
    bb = updated.splitlines(keepends=True)
    operations = difflib.SequenceMatcher(None, aa, bb, autojunk=False).get_opcodes()
    changed = 0
    for tag, a0, a1, b0, b1 in operations:
        if tag == 'equal':
            continue
        old = ''.join(aa[a0:a1])
        new = ''.join(bb[b0:b1])
        if filename == 'risk-runner.mjs' and 'const GUARDIAN_DYNAMIC_EXIT_ENABLED=' in old:
            if 'const GUARDIAN_DYNAMIC_EXIT_ENABLED=' in live:
                pass
            else:
                anchor = 'const STATUS_MS = 2000;\n'
                if live.count(anchor) != 1 or 'const GUARDIAN_ENV_ENABLED=' not in new:
                    raise ValueError('RISK_RUNNER_INSERTION_UNSAFE')
                live = live.replace(anchor, anchor + new, 1)
                changed += 1
                continue
        if old:
            if live.count(old) != 1:
                raise ValueError(f'LIVE_PATCH_ANCHOR_MISMATCH:{filename}:{tag}:{a0}:{len(old)}')
            live = live.replace(old, new, 1)
        else:
            # Pure insertions require the exact adjacent baseline context.
            inserted = False
            for length in (5, 4, 3, 2, 1):
                prior = ''.join(aa[max(0, a0-length):a0])
                subsequent = ''.join(aa[a0:a0+length])
                token = prior + subsequent
                if token and live.count(token) == 1:
                    live = live.replace(token, prior + new + subsequent, 1)
                    inserted = True
                    break
            if not inserted:
                raise ValueError(f'LIVE_INSERTION_CONTEXT_MISMATCH:{filename}:{a0}')
        changed += 1
    if not changed or markers[filename] not in live:
        raise ValueError('GUARDIAN_PATCH_NOT_APPLIED')
    # Do not weaken real-site login, existing risk status, or Alibaba Redis paths.
    if filename == 'control-shell.mjs':
        if ('x-zl-verified-login' in base) != ('x-zl-verified-login' in live):
            raise ValueError('LOGIN_GUARD_REGRESSION')
        if 'pinOK(body.pin, req)' not in live:
            raise ValueError('GUARDIAN_SAME_ORIGIN_CHECK_MISSING')
        if '/api/risk-control' not in live:
            raise ValueError('LEGACY_RISK_ROUTE_LOST')
    if filename == 'risk-runner.mjs':
        for term in ('guardianOpenExposure','guardianDynamicExitDesired',
                     'GUARDIAN_DYNAMIC_EXIT_ENABLED: effectiveGuardian(cfg)'):
            if term not in live:
                raise ValueError('RISK_RUNTIME_GUARD_NOT_WIRED')
    return live

def transform_files(base_dir: Path, new_dir: Path, production_dir: Path, stage_dir: Path):
    result = {}
    for filename in FILES:
        source = (production_dir / filename).read_text(encoding='utf-8')
        prior = (base_dir / filename).read_text(encoding='utf-8')
        wanted = (new_dir / filename).read_text(encoding='utf-8')
        patched = overlay(prior, wanted, source, filename)
        (stage_dir / filename).write_text(patched, encoding='utf-8')
        result[filename] = len(patched)
    return result

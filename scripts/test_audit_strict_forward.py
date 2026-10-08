import unittest
from audit_strict_forward import audit

LOCK = {"round_id":"100","model":"Selective V2","direction":"UP","locked_at":"2026-10-08T18:00:00Z"}
OFFICIAL = {"round_id":"100","official_direction":"UP","settled_at":"2026-10-08T18:05:00Z","source_reference":"official-record-100"}

class AuditTests(unittest.TestCase):
    def check(self, locks, official, expected):
        self.assertEqual(audit(locks,official)["records"][0]["result"],expected)
    def test_hit(self): self.check([LOCK],[OFFICIAL],"HIT")
    def test_miss(self): self.check([LOCK],[dict(OFFICIAL,official_direction="DOWN")],"MISS")
    def test_missing(self): self.check([LOCK],[],"UNVERIFIED")
    def test_duplicate_lock(self): self.check([LOCK,LOCK],[OFFICIAL],"UNVERIFIED")
    def test_duplicate_official(self): self.check([LOCK],[OFFICIAL,OFFICIAL],"UNVERIFIED")
    def test_late_lock(self): self.check([dict(LOCK,locked_at="2026-10-08T18:06:00Z")],[OFFICIAL],"UNVERIFIED")
    def test_missing_provenance(self): self.check([LOCK],[dict(OFFICIAL,source_reference="")],"UNVERIFIED")
    def test_invalid_direction(self): self.check([dict(LOCK,direction="WAIT")],[OFFICIAL],"UNVERIFIED")
    def test_naive_timestamp(self): self.check([dict(LOCK,locked_at="2026-10-08T18:00:00")],[OFFICIAL],"UNVERIFIED")

if __name__ == "__main__":
    unittest.main()

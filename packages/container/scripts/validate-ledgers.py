#!/usr/bin/env python3
import argparse
import hashlib
import json
import pathlib
import sys


DEFAULT_DATA_ROOT = pathlib.Path("/srv/data/pi-system")


def stable_json(value) -> str:
    return json.dumps(value, sort_keys=True, indent=2, separators=(",", ": "))


def hash_record(record) -> str:
    return hashlib.sha256(stable_json(record).encode("utf-8")).hexdigest()


def validate_ledger(path: pathlib.Path) -> int:
    if not path.exists():
        print(f"Ledger absent, skipping: {path}")
        return 0

    previous_hash = ""
    expected_sequence = 1
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except Exception as exc:
                print(f"{path}:{line_number}: invalid JSON: {exc}", file=sys.stderr)
                return 1

            record_hash = record.get("record_hash")
            base_record = dict(record)
            base_record.pop("record_hash", None)

            if record.get("sequence") != expected_sequence:
                print(f"{path}:{line_number}: invalid sequence", file=sys.stderr)
                return 1
            if record.get("previous_hash") != previous_hash:
                print(f"{path}:{line_number}: previous_hash does not match prior record", file=sys.stderr)
                return 1
            if record_hash != hash_record(base_record):
                print(f"{path}:{line_number}: record_hash does not match record contents", file=sys.stderr)
                return 1

            previous_hash = record_hash
            expected_sequence += 1

    print(f"Ledger integrity checks passed: {path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", default=str(DEFAULT_DATA_ROOT))
    args = parser.parse_args()
    data_root = pathlib.Path(args.data_root)

    for ledger in [
        data_root / "audit" / "audit.jsonl",
        data_root / "evidence" / "ledger.jsonl",
    ]:
        status = validate_ledger(ledger)
        if status:
            return status
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

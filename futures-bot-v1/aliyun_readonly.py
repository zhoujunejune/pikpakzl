#!/usr/bin/env python3
"""Read-only Alibaba Cloud SWAS check. Never executes server commands."""
import os
import sys

REGION="ap-southeast-1"
TARGET="b67374069bb3457ba6a3a2ede9305d3f"
ENDPOINT="swas.ap-southeast-1.aliyuncs.com"

def main():
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("PREFLIGHT_ERROR: GitHub Actions secret missing")
        return 2
    print("PREFLIGHT: GitHub secrets present; values hidden")
    try:
        from alibabacloud_swas_open20200601.client import Client
        from alibabacloud_swas_open20200601 import models as swas_models
        from alibabacloud_tea_openapi import models as openapi_models
    except ImportError:
        print("PREFLIGHT_ERROR: Alibaba Cloud SDK import failed")
        return 3
    client=Client(openapi_models.Config(access_key_id=key,access_key_secret=secret,endpoint=ENDPOINT,region_id=REGION))
    try:
        req=swas_models.ListInstancesRequest(region_id=REGION,instance_name=TARGET,page_size=20)
        result=client.list_instances(req)
        matches=[x for x in (result.body.instances or []) if TARGET in (getattr(x,"instance_id",None),getattr(x,"instance_name",None))]
        if not matches:
            print("PREFLIGHT_ERROR: no matching server visible; verify name/ID and RAM scope")
            return 4
        if len(matches)!=1:
            print("PREFLIGHT_ERROR: multiple matching servers")
            return 5
        found=matches[0]
        real_id=getattr(found,"instance_id","")
        if not real_id:
            print("PREFLIGHT_ERROR: no actual instance ID returned")
            return 6
        print("PREFLIGHT_OK: Alibaba SWAS read-only authentication successful")
        print("REGION:",REGION)
        print("SERVER_NAME_MATCH:",getattr(found,"instance_name",None)==TARGET)
        print("SERVER_ID:",real_id)
        print("SERVER_STATUS:",getattr(found,"status","unknown"))
        print("READ_ONLY: true")
        print("DEPLOYMENT: not started")
        return 0
    except Exception as exc:
        # Do not print exception messages or request/response bodies.
        code=getattr(exc,"code",None) or getattr(exc,"status_code",None)
        print("PREFLIGHT_API_ERROR_TYPE:",type(exc).__name__)
        print("PREFLIGHT_API_ERROR_CODE:",str(code or "unknown")[:80])
        print("PREFLIGHT_DIAGNOSIS: check RAM swas-open:ListInstances permission, region and target")
        return 7
if __name__=="__main__":
    sys.exit(main())

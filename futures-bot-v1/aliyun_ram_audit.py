#!/usr/bin/env python3
"""Read-only RAM direct and group policy-name audit for existing RAM user 'lz'.
Outputs policy names and types, never credentials, policy documents or account IDs.
A successful check is not proof of least privilege: custom policies, resource
scoped grants and group inheritance require a deeper review.
"""
import os

USER="lz"
def main():
    key=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID","")
    secret=os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET","")
    if not key or not secret:
        print("RAM_AUDIT: secrets unavailable")
        return 0
    try:
        from alibabacloud_ram20150501.client import Client
        from alibabacloud_ram20150501 import models as ram_models
        from alibabacloud_tea_openapi import models as openapi_models
    except ImportError:
        print("RAM_AUDIT: SDK unavailable")
        return 0
    api=Client(openapi_models.Config(access_key_id=key,access_key_secret=secret,endpoint="ram.aliyuncs.com"))
    direct=[]
    try:
        result=api.list_policies_for_user(ram_models.ListPoliciesForUserRequest(user_name=USER))
        direct=result.body.policies.policy or []
    except Exception as exc:
        # No additional grants should be requested simply to inspect them.
        print("RAM_AUDIT: direct policies not readable")
        print("RAM_AUDIT_ERROR_TYPE:",type(exc).__name__)
        print("RAM_AUDIT_ERROR_CODE:",str(getattr(exc,"code","unknown"))[:50])
        return 0
    groups=[]
    try:
        result=api.list_groups_for_user(ram_models.ListGroupsForUserRequest(user_name=USER))
        groups=result.body.groups.group or []
    except Exception:
        print("RAM_AUDIT_NOTE: group memberships could not be queried")
    name_set=set()
    def add_policy(p,source):
        name=str(getattr(p,"policy_name","unknown"))[:100]
        ptype=str(getattr(p,"policy_type","unknown"))[:30]
        name_set.add(name.lower())
        print("RAM_POLICY:",source,ptype,name)
    for p in direct:
        add_policy(p,"direct")
    for group in groups:
        group_name=str(getattr(group,"group_name",""))[:100]
        if not group_name:
            continue
        try:
            result=api.list_policies_for_group(ram_models.ListPoliciesForGroupRequest(group_name=group_name))
            for p in result.body.policies.policy or []:
                add_policy(p,"group:"+group_name)
        except Exception:
            print("RAM_AUDIT_NOTE: group policies not readable for",group_name)
    print("RAM_AUDIT_DIRECT_COUNT:",len(direct))
    print("RAM_AUDIT_GROUP_COUNT:",len(groups))
    risky=[x for x in name_set if "fullaccess" in x or "admin" in x or "write" in x or "manage" in x]
    print("RAM_AUDIT_POTENTIALLY_BROAD_POLICIES:",",".join(sorted(risky)) if risky else "none-obvious")
    print("RAM_AUDIT_CAUTION: custom-policy contents and resource-group grants not fully examined")
    return 0

if __name__=="__main__":
    raise SystemExit(main())

# MSRC_IDENTITY_SECURITY_AUDIT

Program: Microsoft Identity Bounty
Official rules: https://microsoft.com/msrc/bounty-microsoft-identity
Audit date: 2026-11-05
Award range: $375 - $100,000 USD

## Scope (authorized assets)
login.windows.net, login.microsoftonline.com, login.live.com, account.live.com, account.microsoft.com, signup.live.com, account.windowsazure.com, account.activedirectory.windowsazure.com, credential.activedirectory.windowsazure.com, passwordreset.microsoftonline.com, Microsoft Authenticator (iOS/Android), Microsoft Authenticator Broker, Microsoft Authenticator Lite, graph.microsoft.com Identity APIs, Azure AD B2C, adminwebservice.microsoftonline.com, api.mysignins.microsoft.com, provisioningapi.microsoftonline.com, myaccess/myapps/myaccount/microsoft.com, microsoftazuread-sso.com, mysignins.microsoft.com, accounts.accesscontrol.windows.net, OpenID certified implementations.

## Exclusions
DoS, low-impact CSRF, subdomain takeovers, missing headers, third-party without impact, draft standards, non-certified implementations, reports from automated scans, training/docs sites.

## Coverage matrix
Authentication: Applicable (core)
Authorization: Applicable
IDOR/BOLA: Applicable (graph APIs)
Privilege Escalation: Applicable
XSS: Applicable (spoofing via XSS)
CSRF: Applicable
SSRF: Not applicable (no server-side fetch in scope assets per docs)
SQLi: Not applicable (managed service, no direct DB access)
Command Injection: Not applicable
XXE: Not applicable
SSTI: Not applicable
Path Traversal: Applicable (identity endpoints)
Deserialization: Not applicable
Memory Corruption: Not applicable (managed cloud)
Race Conditions: Applicable (auth flows)
Cryptography: Applicable (OpenID/OAuth)
API Security: Applicable
Cloud Security: Applicable
Windows/Azure/Identity Security: Applicable (Identity)
Mobile Security: Applicable (Authenticator apps)
Source/Dependency/Config/AI Security: Partially applicable

## Tests executed
Passive review of official program documentation and scope. No active testing performed (requires human approval per ROE).

## Tests pending
Active low-intensity testing on own test accounts after approval; correlation ID capture.

## Vulnerabilities detected
None confirmed. No se han identificado vulnerabilidades confirmadas en las pruebas realizadas.

## Limitations
Passive-only phase. No test accounts created. No scanning executed. Findings are hypotheses pending validation.

## Conclusion
Audit scaffold complete. Active testing requires human approval and dedicated test tenants.

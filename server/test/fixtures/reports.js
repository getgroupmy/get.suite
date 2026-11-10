// Sample DMARC (XML) and TLS (JSON) reports, as Google and Microsoft send them.
export const DMARC = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback><report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email><report_id>123456</report_id>
<date_range><begin>1762646400</begin><end>1762732799</end></date_range></report_metadata>
<policy_published><domain>acme.com</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><pct>100</pct></policy_published>
<record><row><source_ip>203.0.113.10</source_ip><count>42</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>acme.com</header_from></identifiers></record>
<record><row><source_ip>198.51.100.7</source_ip><count>3</count><policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row><identifiers><header_from>acme.com</header_from></identifiers></record>
<record><row><source_ip>203.0.113.10</source_ip><count>5</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row><identifiers><header_from>acme.com</header_from></identifiers></record>
</feedback>`;
export const TLS = JSON.stringify({ 'organization-name': 'Microsoft Corporation', 'date-range': { 'start-datetime': '2026-11-09T00:00:00Z', 'end-datetime': '2026-11-09T23:59:59Z' }, 'report-id': 'abc',
  policies: [{ policy: { 'policy-type': 'sts', 'policy-domain': 'acme.com' }, summary: { 'total-successful-session-count': 120, 'total-failure-session-count': 2 },
    'failure-details': [{ 'result-type': 'certificate-expired', 'receiving-mx-hostname': 'mail.acme.com', 'failed-session-count': 2 }] }] });


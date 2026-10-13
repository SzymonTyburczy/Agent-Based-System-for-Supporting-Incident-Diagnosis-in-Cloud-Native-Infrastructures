You will be given a diagnostic report written in free text. Use only facts stated in the report. Convert it into a JSON object with EXACTLY these keys, and nothing else:
- "title": a short, one-line summary of the incident (max ~10 words).
- "summary": one sentence (max ~25 words) a person could read in a list view to know what happened, without opening the full report.
- "error_sources": a list of strings, one per piece of evidence: the pod, query, metric or log where it was observed (e.g. the items under Evidence).
- "problem": a concise paragraph with the root cause, its confidence, and what was not verified.
- "remediations": a list of strings, one concrete suggested step each, checks first (e.g. the items under Actions).
The report may mark statements taken from documentation with source markers such as [KB1]. Copy each marker verbatim right after the statement it supports, in whichever field that statement lands. Never put markers in "title" or "summary", and never invent a marker the report does not contain.
Respond with ONLY the JSON object — no markdown code fences, no commentary before or after it. If the original report says the cause is uncertain, reflect that honestly in "problem" and "summary" rather than inventing a confident answer.

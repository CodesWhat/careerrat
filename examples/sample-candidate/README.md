# Sample Candidate Workspace — Riley Chen (Fictional)

This is a complete, fictional worked example of a CareerRat candidate workspace.
Riley Chen is not a real person. Every field is filled in with realistic but
made-up data so you can see exactly what a finished workspace looks like before
you create your own.

## How to use it

**Option A — copy and adapt:**

```
cp -r examples/sample-candidate/ candidate/
# Then open each file and replace Riley's data with your own.
```

**Option B — start fresh with the init wizard:**

```
careerrat init
# Follow the prompts to fill out your profile interactively.
```

After setting up `candidate/`, run `careerrat doctor` to verify everything is
valid, then `careerrat searches --from-targeting` to build your search sources.

## Files in this directory

| File | Purpose |
|------|---------|
| `profile.yml` | Identity, compensation targets, location preferences, and work authorization. |
| `targeting.yml` | Role buckets (primary/secondary/stretch/oe), keep/cut signals that filter job postings, and excluded companies. |
| `evidence.yml` | Claim bank — each entry is a verifiable accomplishment with evidence, metrics, and wording guidance. Tailored resumes and cover letters draw from this. |
| `honesty.yml` | Hard boundaries: which tools you can honestly claim, what must never be fabricated, and style guardrails. |
| `form-defaults.yml` | Pre-filled answers for common application form fields. `auto_submit` is always `false` — you confirm before anything is submitted. |

## Keeping your data private

`candidate/` is listed in `.gitignore`. Never commit it to a public repo.

# MineShield Backend

This folder contains the FastAPI backend for MineShield.

## Quick start (development)

1. Create a Python 3.11 virtual environment and install dependencies (recommended):

```powershell
cd mineshield_app/backend
# Create venv using Python 3.11 (Windows)
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Linux / macOS:

```bash
cd mineshield_app/backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Configure optional environment variables in a `.env` file (SMTP/Twilio):

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASS=yourpassword
TWILIO_SID=ACxxxx
TWILIO_TOKEN=xxxx
TWILIO_FROM=+1234567890
```

3. Start the API server (inside the activated venv):

```powershell
# Windows (from mineshield_app/backend) with venv activated
py -3.11 -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Linux / macOS
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

4. Generate demo data (optional) and send a demo alert:

```powershell
# (Optional) create a small demo dataset used by the live prediction fallback
py -3.11 ..\..\demo\generate_demo_parquet.py

# Send a demo alert (from mineshield_app/backend)
py -3.11 demo_send_alert.py
```

## Notes
- The backend will only attempt to send email/SMS when the corresponding environment variables are set.
- SMS uses Twilio via `TWILIO_SID`, `TWILIO_TOKEN`, and `TWILIO_FROM`.
- Email uses SMTP with STARTTLS.


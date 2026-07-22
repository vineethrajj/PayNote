#!/usr/bin/env python3
"""
Generate a QR code PNG that points at your deployed Bill Note web app.
Staff can scan it (Camera app on iPhone) to open the app, then Add to Home
Screen. Handy printed at the front desk or forwarded on WhatsApp.

Usage:
    python3 tools/make_qr.py "https://script.google.com/.../exec"
    python3 tools/make_qr.py "<url>" --out tools/bill-note-qr.png

Requires: qrcode + pillow  (pip install qrcode pillow)
"""
import sys
import argparse


def main():
    ap = argparse.ArgumentParser(description="Make a QR PNG for the Bill Note app link.")
    ap.add_argument("url", help="The deployed web-app URL (…/exec).")
    ap.add_argument("--out", default="tools/bill-note-qr.png", help="Output PNG path.")
    args = ap.parse_args()

    if not (args.url.startswith("http://") or args.url.startswith("https://")):
        sys.exit("URL must start with http:// or https://")

    try:
        import qrcode
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install qrcode pillow")

    qr = qrcode.QRCode(
        version=None,                       # auto-size to fit the URL
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=12,
        border=3,
    )
    qr.add_data(args.url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0d9488", back_color="white")
    img.save(args.out)
    print("Wrote %s  (%dx%d)" % (args.out, img.size[0], img.size[1]))
    print("Scan it with the iPhone Camera app, then Add to Home Screen.")


if __name__ == "__main__":
    main()

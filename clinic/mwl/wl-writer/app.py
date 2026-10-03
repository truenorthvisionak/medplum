"""
Turns a JSON order into a DICOM Modality Worklist file that Orthanc serves.

Ported from the clinic's OpenEMR/VISUSCREEN prototype. Medplum's
appointment-to-worklist bot POSTs one JSON order per appointment; devices
(IMAGEnet 6 / Maestro2, IOLMaster, ...) C-FIND the entries from Orthanc.

  POST   /worklist          {json order}   -> writes <accession>.wl
  GET    /worklist                         -> list current entries
  DELETE /worklist/<name>                  -> remove one entry
  DELETE /worklist                         -> clear all entries
  DELETE /worklist?before=YYYYMMDD         -> prune entries scheduled before a date

Identity contract: patient_id = clinic MRN, accession = Medplum Appointment id.

Timezone: send `sps_start_iso` (ISO 8601 with offset) and this service formats
the scheduled date/time in ITS OWN local timezone (container TZ) — which must
match the devices' clocks, or "today's worklist" silently comes back empty.
"""
import json
import os
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.uid import generate_uid

WL_DIR = os.environ.get("WORKLIST_DIR", "/worklists")
PORT = int(os.environ.get("PORT", "8500"))
DEFAULT_MODALITY = os.environ.get("DEFAULT_MODALITY", "OPT")
DEFAULT_STATION_AET = os.environ.get("DEFAULT_STATION_AET", "CLINIC")

SAFE = re.compile(r"[^A-Za-z0-9._-]")


def local_sps_datetime(o):
    """Scheduled date/time strings in this container's local timezone."""
    iso = o.get("sps_start_iso")
    if iso:
        moment = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    else:
        moment = datetime.now()
    return (
        o.get("sps_start_date", moment.strftime("%Y%m%d")),
        o.get("sps_start_time", moment.strftime("%H%M%S")),
    )


def build_worklist(o):
    ds = Dataset()
    ds.SpecificCharacterSet = "ISO_IR 100"

    # --- Patient Identification / Demographics -----------------------------
    ds.PatientName = o.get("patient_name", "")           # "Family^Given"
    ds.PatientID = o.get("patient_id", "")               # clinic MRN
    ds.IssuerOfPatientID = o.get("issuer_of_patient_id", "")
    ds.PatientBirthDate = o.get("birth_date", "")        # YYYYMMDD
    ds.PatientSex = o.get("sex", "")                     # M / F / O

    # --- Imaging Service Request ------------------------------------------
    ds.AccessionNumber = o.get("accession", "")          # Medplum Appointment id
    ds.ReferringPhysicianName = o.get("referring_physician", "")
    ds.RequestingPhysician = o.get("requesting_physician", "")

    # --- Requested Procedure ----------------------------------------------
    ds.StudyInstanceUID = o.get("study_instance_uid") or generate_uid()
    ds.RequestedProcedureID = o.get("requested_procedure_id", "")
    ds.RequestedProcedureDescription = o.get("requested_procedure_description", "")

    # --- Scheduled Procedure Step -----------------------------------------
    # Modality + SPS start date are the typical device matching keys; they must
    # be right or the device sees an empty list with no error.
    sps_date, sps_time = local_sps_datetime(o)
    sps = Dataset()
    sps.Modality = o.get("modality", DEFAULT_MODALITY)
    sps.ScheduledProcedureStepStartDate = sps_date
    sps.ScheduledProcedureStepStartTime = sps_time
    sps.ScheduledProcedureStepDescription = o.get("sps_description", "")
    sps.ScheduledProcedureStepID = o.get("sps_id", o.get("accession", ""))
    sps.ScheduledStationAETitle = o.get("station_aet", DEFAULT_STATION_AET)
    sps.ScheduledPerformingPhysicianName = o.get("performing_physician", "")
    ds.ScheduledProcedureStepSequence = [sps]

    # Worklist files are bare datasets - no File Meta Information.
    ds.is_little_endian = True
    ds.is_implicit_VR = True
    return ds


def entry_sps_date(path):
    try:
        ds = dcmread(path, force=True)
        return str(ds.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate)
    except Exception:
        return ""


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code, payload):
        body = json.dumps(payload, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path.rstrip("/") not in ("/worklist", ""):
            return self._reply(404, {"error": "not found"})
        items = sorted(f for f in os.listdir(WL_DIR) if f.endswith(".wl"))
        self._reply(200, {"count": len(items), "entries": items})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        parts = parsed.path.rstrip("/").split("/")
        removed = 0

        if len(parts) >= 3 and parts[1] == "worklist" and parts[2]:
            name = SAFE.sub("_", parts[2].removesuffix(".wl"))
            path = os.path.join(WL_DIR, f"{name}.wl")
            if os.path.exists(path):
                os.remove(path)
                removed = 1
            return self._reply(200, {"removed": removed})

        before = parse_qs(parsed.query).get("before", [None])[0]
        for f in os.listdir(WL_DIR):
            if not f.endswith(".wl"):
                continue
            path = os.path.join(WL_DIR, f)
            if before and not entry_sps_date(path) < before:
                continue
            os.remove(path)
            removed += 1
        self._reply(200, {"removed": removed})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            order = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as exc:
            return self._reply(400, {"error": f"invalid JSON: {exc}"})

        if not order.get("patient_id"):
            return self._reply(400, {"error": "patient_id is required"})

        ds = build_worklist(order)
        name = SAFE.sub("_", order.get("accession") or order["patient_id"])
        path = os.path.join(WL_DIR, f"{name}.wl")
        ds.save_as(path, write_like_original=True)

        sps = ds.ScheduledProcedureStepSequence[0]
        print(f"wrote {path}  patient={ds.PatientID} "
              f"modality={sps.Modality} date={sps.ScheduledProcedureStepStartDate}",
              flush=True)
        self._reply(201, {
            "file": os.path.basename(path),
            "patient_id": str(ds.PatientID),
            "modality": str(sps.Modality),
            "sps_start_date": str(sps.ScheduledProcedureStepStartDate),
            "sps_start_time": str(sps.ScheduledProcedureStepStartTime),
            "study_instance_uid": str(ds.StudyInstanceUID),
        })

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    os.makedirs(WL_DIR, exist_ok=True)
    print(f"wl-writer listening on :{PORT}, writing to {WL_DIR}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

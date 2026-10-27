"""Firestore REST API with a service-account key, read-only: OAuth2 JWT-bearer token, runQuery
paging and a decoder for Firestore's typed values. Copied from the Spatial Video Studio KPI
(kpi/backend/kpi/firestore.py) without its write helpers: this dashboard never writes to Firestore.
The key and the token are never logged."""
import datetime as dt
import json
import time
from typing import Any

import httpx
import jwt

BASE = "https://firestore.googleapis.com/v1"
# Read-only would be enough, but Firestore has no narrower OAuth scope; the service account itself
# holds roles/datastore.viewer only.
SCOPE = "https://www.googleapis.com/auth/datastore"
GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
PAGE = 300


def parse_timestamp(text: str) -> dt.datetime:
    """RFC 3339 as Firestore writes it: 'Z' suffix, up to nine fractional digits."""
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if "." in text:
        head, rest = text.split(".", 1)
        frac = ""
        i = 0
        while i < len(rest) and rest[i].isdigit():
            frac += rest[i]
            i += 1
        text = f"{head}.{frac[:6].ljust(6, '0')}{rest[i:]}"
    return dt.datetime.fromisoformat(text)


def format_timestamp(value: dt.datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    value = value.astimezone(dt.timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def decode_value(value: dict) -> Any:
    """One Firestore typed value -> Python. Unknown kinds come back as the raw dict."""
    if "nullValue" in value:
        return None
    if "stringValue" in value:
        return value["stringValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "booleanValue" in value:
        return bool(value["booleanValue"])
    if "timestampValue" in value:
        return parse_timestamp(value["timestampValue"])
    if "mapValue" in value:
        return decode_fields(value["mapValue"].get("fields", {}))
    if "arrayValue" in value:
        return [decode_value(v) for v in value["arrayValue"].get("values", [])]
    if "referenceValue" in value:
        return value["referenceValue"]
    if "bytesValue" in value:
        return value["bytesValue"]
    if "geoPointValue" in value:
        return dict(value["geoPointValue"])
    return value


def decode_fields(fields: dict) -> dict:
    return {k: decode_value(v) for k, v in fields.items()}


def decode_document(doc: dict) -> dict:
    """{'name': 'projects/.../documents/coll/id', 'fields': {...}} -> {'_name', '_id', ...fields}."""
    name = doc["name"]
    out = {"_name": name, "_id": name.rsplit("/", 1)[-1]}
    out.update(decode_fields(doc.get("fields", {})))
    return out


class Client:
    def __init__(self, key_path: str, project: str | None = None) -> None:
        with open(key_path, encoding="utf-8") as f:
            key = json.load(f)
        self.project = project or key.get("project_id")
        if not self.project:
            raise SystemExit("FIRESTORE_PROJECT is not set")
        self._email = key["client_email"]
        self._private_key = key["private_key"]
        self._token_uri = key.get("token_uri", "https://oauth2.googleapis.com/token")
        self._token: str | None = None
        self._expires_at = 0.0
        self.http = httpx.Client(timeout=120)

    @property
    def documents(self) -> str:
        return f"{BASE}/projects/{self.project}/databases/(default)/documents"

    def document_name(self, collection: str, doc_id: str) -> str:
        return f"projects/{self.project}/databases/(default)/documents/{collection}/{doc_id}"

    def token(self) -> str:
        if self._token is None or time.time() > self._expires_at - 5 * 60:
            now = int(time.time())
            assertion = jwt.encode(
                {"iss": self._email, "sub": self._email, "scope": SCOPE, "aud": self._token_uri,
                 "iat": now, "exp": now + 3600},
                self._private_key, algorithm="RS256")
            r = self.http.post(self._token_uri, data={"grant_type": GRANT, "assertion": assertion})
            if r.status_code != 200:
                raise RuntimeError(f"Firestore token exchange failed: HTTP {r.status_code}")
            body = r.json()
            self._token = body["access_token"]
            self._expires_at = time.time() + float(body.get("expires_in", 3600))
        return self._token

    def _post(self, url: str, body: dict) -> httpx.Response:
        for attempt in range(5):
            try:
                r = self.http.post(url, content=json.dumps(body),
                                   headers={"Authorization": "Bearer " + self.token(), "Content-Type": "application/json"})
            except httpx.TransportError:
                # A pooled connection the server closed while idle (the Mac asleep): retry on a new one.
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 ** attempt)
                continue
            return r
        return r

    def run_query(self, collection: str, order_by: str, start_after: tuple[Any, str] | None = None,
                  limit: int = PAGE, where_after: dt.datetime | None = None) -> list[dict]:
        """One page of documents ordered by (order_by asc, __name__ asc), decoded. `order_by` may be
        "__name__" for a full scan that also sees documents lacking every other field. `start_after` is
        (order_by value, document id) of the previous page's last document; `where_after` keeps only
        order_by >= that timestamp (the incremental re-read)."""
        if order_by == "__name__":
            order = [{"field": {"fieldPath": "__name__"}, "direction": "ASCENDING"}]
        else:
            order = [{"field": {"fieldPath": order_by}, "direction": "ASCENDING"},
                     {"field": {"fieldPath": "__name__"}, "direction": "ASCENDING"}]
        query: dict = {"from": [{"collectionId": collection}], "orderBy": order, "limit": limit}
        if where_after is not None and order_by != "__name__":
            query["where"] = {"fieldFilter": {"field": {"fieldPath": order_by}, "op": "GREATER_THAN_OR_EQUAL",
                                              "value": {"timestampValue": format_timestamp(where_after)}}}
        if start_after is not None:
            at, doc_id = start_after
            ref = {"referenceValue": self.document_name(collection, doc_id)}
            values = [ref] if order_by == "__name__" else [{"timestampValue": format_timestamp(at)}, ref]
            query["startAt"] = {"values": values, "before": False}
        r = self._post(self.documents + ":runQuery", {"structuredQuery": query})
        if r.status_code != 200:
            raise RuntimeError(f"Firestore runQuery {collection} failed: HTTP {r.status_code} {r.text[:300]}")
        return [decode_document(item["document"]) for item in r.json() if "document" in item]

    def iterate(self, collection: str, order_by: str = "__name__", where_after: dt.datetime | None = None):
        """Yields pages (lists of decoded documents) until a page comes back short."""
        cursor = None
        while True:
            page = self.run_query(collection, order_by, cursor, PAGE, where_after)
            if not page:
                return
            yield page
            if len(page) < PAGE:
                return
            last = page[-1]
            cursor = (last.get(order_by), last["_id"])

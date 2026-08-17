from fastapi.testclient import TestClient

from mineshield_app.backend.main import app

client = TestClient(app)


def test_session_and_gmail_identity():
    response = client.post(
        "/auth/login",
        json={
            "name": "Nisha Reddy",
            "email": "nisha.reddy@gmail.com",
            "role": "Regional Safety Lead",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["user"]["email"].endswith("@gmail.com")
    assert data["user"]["name"] == "Nisha Reddy"

    session = client.get("/auth/session")
    assert session.status_code == 200, session.text
    session_data = session.json()
    assert session_data["user"]["email"].endswith("@gmail.com")


def test_mines_are_realistic_and_broad():
    response = client.get("/mines")
    assert response.status_code == 200, response.text
    data = response.json()
    assert "mines" in data
    assert len(data["mines"]) >= 12
    assert any("Odisha" in mine["name"] for mine in data["mines"])
    assert any("Jharkhand" in mine["name"] for mine in data["mines"])

# Deployment

This branch contains a standalone static navigation page at `/map/`. It uses browser geolocation for continuous position updates, OpenStreetMap tiles and place search, and public OSRM-compatible route services.

Run locally with `npm start`, then open `http://127.0.0.1:4173/map/`. GPS access requires HTTPS outside localhost and must be granted by the visitor.

The repository includes configuration for static Vercel deployment and a dependency-free Node server for Railway.

import SwiftUI

struct MenuView: View {
    @StateObject private var docker = DockerService.shared

    var body: some View {
        VStack(spacing: 0) {

            // ── Header ────────────────────────────────────────────────────
            HStack {
                Image(systemName: "music.note.list")
                    .foregroundColor(.secondary)
                Text("Stratum")
                    .font(.headline)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            // ── Service status ────────────────────────────────────────────
            VStack(spacing: 6) {
                ServiceRow(name: "slskd",    status: docker.slskdStatus)
                ServiceRow(name: "soulsync", status: docker.soulsyncStatus)
                ServiceRow(name: "webhook",  status: docker.webhookStatus)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider()

            // ── Actions ───────────────────────────────────────────────────
            VStack(spacing: 8) {
                if docker.stackRunning {
                    Button(action: { docker.sync() }) {
                        Label(docker.isSyncing ? "Syncing…" : "Sync to Garage + D1",
                              systemImage: docker.isSyncing ? "arrow.triangle.2.circlepath" : "arrow.up.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(docker.isSyncing)

                    Button(action: { docker.stopStack() }) {
                        Label("Stop Stack", systemImage: "stop.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button(action: { docker.startStack() }) {
                        Label("Start Stack", systemImage: "play.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            // ── Sync log ──────────────────────────────────────────────────
            if !docker.syncLog.isEmpty {
                Divider()
                VStack(spacing: 4) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            Text(docker.syncLog)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundColor(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(8)
                                .id("log")
                        }
                        .frame(height: 120)
                        .background(Color(NSColor.textBackgroundColor))
                        .onChange(of: docker.syncLog) { _ in
                            proxy.scrollTo("log", anchor: .bottom)
                        }
                    }
                    HStack {
                        Spacer()
                        Button("Copy Log") { docker.copyLog() }
                            .font(.caption)
                            .buttonStyle(.plain)
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 4)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }

            Divider()

            // ── Bottom row ────────────────────────────────────────────────
            HStack {
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
                    .font(.caption)
                Spacer()
                Link("slskd", destination: URL(string: "http://localhost:5030")!)
                    .font(.caption).foregroundColor(.secondary)
                Text("·").foregroundColor(.secondary).font(.caption)
                Link("soulsync", destination: URL(string: "http://localhost:8008")!)
                    .font(.caption).foregroundColor(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .frame(width: 300)
    }
}

struct ServiceRow: View {
    let name: String
    let status: DockerService.ServiceStatus

    var body: some View {
        HStack {
            Circle()
                .fill(status == .running ? Color.green : status == .stopped ? Color.red : Color.gray)
                .frame(width: 8, height: 8)
            Text(name)
                .font(.system(.body, design: .monospaced))
            Spacer()
            Text(status.label)
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

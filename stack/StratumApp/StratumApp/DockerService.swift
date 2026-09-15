// SPDX-License-Identifier: MIT
import Foundation
import AppKit
import Combine

class DockerService: ObservableObject {
    static let shared = DockerService()

    @Published var slskdStatus: ServiceStatus = .unknown
    @Published var soulsyncStatus: ServiceStatus = .unknown
    @Published var webhookStatus: ServiceStatus = .unknown
    @Published var isSyncing = false
    @Published var syncLog: String = ""

    private var timer: Timer?
    private let composeDir: String

    enum ServiceStatus {
        case running, stopped, unknown
        var label: String { self == .running ? "running" : self == .stopped ? "stopped" : "—" }
    }

    var stackRunning: Bool {
        slskdStatus == .running || soulsyncStatus == .running || webhookStatus == .running
    }
    var isRunning: Bool { stackRunning }

    private let dockerPath: String = {
        ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"]
            .first { FileManager.default.fileExists(atPath: $0) } ?? "/usr/local/bin/docker"
    }()

    init() {
        composeDir = (NSHomeDirectory() as NSString).appendingPathComponent("stratum-sulcus-mac")
        startPolling()
    }

    func startPolling() {
        checkStatus()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.checkStatus()
        }
    }

    func checkStatus() {
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let slskd   = self.docker(["inspect", "-f", "{{.State.Running}}", "slskd"]).trimmingCharacters(in: .whitespacesAndNewlines) == "true"
            let soulsync = self.docker(["inspect", "-f", "{{.State.Running}}", "soulsync"]).trimmingCharacters(in: .whitespacesAndNewlines) == "true"
            let webhook  = self.docker(["inspect", "-f", "{{.State.Running}}", "webhook-receiver"]).trimmingCharacters(in: .whitespacesAndNewlines) == "true"
            DispatchQueue.main.async {
                self.slskdStatus    = slskd    ? .running : .stopped
                self.soulsyncStatus = soulsync ? .running : .stopped
                self.webhookStatus  = webhook  ? .running : .stopped
            }
        }
    }

    func startStack() {
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            _ = self.docker(["compose", "up", "-d"], cwd: self.composeDir)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.checkStatus() }
        }
    }

    func stopStack() {
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            _ = self.docker(["compose", "down"], cwd: self.composeDir)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.checkStatus() }
        }
    }

    func sync() {
        guard !isSyncing else { return }
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            DispatchQueue.main.async {
                self.isSyncing = true
                self.syncLog = ""
            }

            let task = Process()
            task.executableURL = URL(fileURLWithPath: self.dockerPath)
            task.arguments = ["compose", "--profile", "sync", "run", "--rm", "sync"]
            task.currentDirectoryURL = URL(fileURLWithPath: self.composeDir)

            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError  = pipe

            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let str = String(data: data, encoding: .utf8) else { return }
                DispatchQueue.main.async { self?.syncLog += str }
            }

            try? task.run()
            task.waitUntilExit()
            pipe.fileHandleForReading.readabilityHandler = nil

            DispatchQueue.main.async {
                self.isSyncing = false
                if self.syncLog.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    self.syncLog = "✓ Done"
                }
            }
        }
    }

    func copyLog() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(syncLog, forType: .string)
    }

    @discardableResult
    func docker(_ args: [String], cwd: String? = nil) -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: dockerPath)
        task.arguments = args
        if let cwd { task.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError  = pipe
        try? task.run()
        task.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}

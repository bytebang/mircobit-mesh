//----------------------------------------------------------------------------------------
// Packet format
// ---------------------------------------------------------------------------------------
//
//   PATH>DEST[#SEQ]:PAYLOAD      e.g.  R7*,!3-3>UP#a:HELLO   or   R7*,!3-3>UP#12345:HELLO
//
//   PATH     comma separated list of hops. The first hop is always the source.
//              "E5*"       station E5 has already transmitted the packet
//              "E9"        explicit next hop (source routing), not yet processed
//              "?max-rest" flooding relay: any station may retransmit, inserts its own
//                          callsign before the token and decrements "rest"
//              "!max-rest" anonymous flooding relay: like "?" but WITHOUT inserting
//                          the callsign (keeps the packet short, nothing can be learned)
//              "...-0"     relay budget exhausted -> no further retransmission
//   DEST     station id of the receiver
//   SEQ      optional sequence number: everything between '#' and ':' (any length, no
//            reserved characters). If present, duplicates are detected by SOURCE+DEST+SEQ,
//            so the same payload can be sent several times in a row.
//            If absent, duplicates are detected by SOURCE+DEST+PAYLOAD (like APRS), i.e.
//            identical messages within cacheLifetime are treated as duplicates.
//   PAYLOAD  everything after the first ':' - may contain any character (also ':' or '>')
//
// Station ids and sequence numbers must not contain any of the reserved
// characters ",>:*?!#" and must not be empty.
// ---------------------------------------------------------------------------------------

const MESH_RESERVED_CHARS = ",>:*?!#";
const MESH_SEQ_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Checks if a string can be used as station id (or sequence number):
 * not empty and no reserved characters
 */
function meshIsValidId(id: string): boolean {
    if (!id || id.length == 0) {
        return false;
    }
    for (let i = 0; i < id.length; i++) {
        if (MESH_RESERVED_CHARS.indexOf(id.charAt(i)) >= 0) {
            return false;
        }
    }
    return true;
}

/**
 * Checks if a string consists only of the digits 0-9 (and is not empty)
 */
function meshIsNumber(s: string): boolean {
    if (!s || s.length == 0) {
        return false;
    }
    for (let i = 0; i < s.length; i++) {
        if ("0123456789".indexOf(s.charAt(i)) < 0) {
            return false;
        }
    }
    return true;
}

/**
 * true if the hop is a relay token ("?max-rest" or "!max-rest")
 */
function meshIsRelayToken(hop: string): boolean {
    let c = hop.charAt(0);
    return c == "?" || c == "!";
}

/**
 * true if the relay token is well formed: "?<max>-<rest>" or "!<max>-<rest>"
 */
function meshIsValidRelayToken(hop: string): boolean {
    if (!meshIsRelayToken(hop)) {
        return false;
    }
    let parts = hop.substr(1).split("-");
    return parts.length == 2 && meshIsNumber(parts[0]) && meshIsNumber(parts[1]);
}

/**
 * Returns the configured maximum number of relays of a relay token
 */
function meshRelayMax(hop: string): number {
    return parseInt(hop.substr(1).split("-")[0]);
}

/**
 * Returns the remaining number of relays of a relay token
 */
function meshRelayRest(hop: string): number {
    return parseInt(hop.substr(1).split("-")[1]);
}

/**
 * true if the hop is a station that has already transmitted the packet ("E5*")
 */
function meshIsUsedStation(hop: string): boolean {
    return hop.length > 1 && hop.charAt(hop.length - 1) == "*" && !meshIsRelayToken(hop);
}

//----------------------------------------------------------------------------------------
// A small set of strings where each entry expires after a while
// ---------------------------------------------------------------------------------------
class ExpiringSet {
    private keys: string[] = [];
    private expiries: number[] = [];
    private maxEntries: number;

    constructor(maxEntries: number) {
        this.maxEntries = maxEntries;
    }

    /**
     * Adds (or refreshes) a key
     * @param lifetime Time in seconds till the entry becomes invalid
     */
    add(key: string, lifetime: number) {
        this.purge();
        let expiry = control.millis() + lifetime * 1000;
        let idx = this.keys.indexOf(key);
        if (idx >= 0) {
            this.expiries[idx] = expiry;
            return;
        }

        // Limit memory usage: drop the oldest entry
        if (this.keys.length >= this.maxEntries) {
            this.keys.removeAt(0);
            this.expiries.removeAt(0);
        }
        this.keys.push(key);
        this.expiries.push(expiry);
    }

    has(key: string): boolean {
        this.purge();
        return this.keys.indexOf(key) >= 0;
    }

    private purge() {
        let now = control.millis();
        for (let i = this.keys.length - 1; i >= 0; i--) {
            if (now > this.expiries[i]) {
                this.keys.removeAt(i);
                this.expiries.removeAt(i);
            }
        }
    }
}

//----------------------------------------------------------------------------------------
// A Simple routingtable implementation
// ---------------------------------------------------------------------------------------
class RoutingTable {
    private destinations: string[] = [];
    private routes: string[] = [];       // "HOP1,HOP2,HOPn" or "" for a direct neighbour
    private expiries: number[] = [];
    private defaultRoute: string;

    constructor(defaultRoute: string) {
        this.defaultRoute = defaultRoute;
    }

    /**
     * Gets the route to the station. If the route is not known, then the
     * default route will be returned.
     *
     * @returns route ("" = direct) or the default route
     */
    getRouteTo(otherStation: string): string {
        this.removeExpiredRoutes();
        let idx = this.destinations.indexOf(otherStation);
        if (idx >= 0) {
            return this.routes[idx];
        }
        return this.defaultRoute;
    }

    /**
     * Learns the return routes to all stations in the path of a received packet.
     *
     * The path "E3*,E5*,E9*,?2-1" (received by us) results in:
     *   E3 -> "E9,E5"
     *   E5 -> "E9"
     *   E9 -> ""      (direct neighbour - we have heard it)
     *
     * If anonymous relays ("!") have been used, the path is incomplete and
     * nothing can be learned.
     */
    addReverseRoutes(hops: string[], lifetime = 30) {
        // Anonymous relays used -> we do not know the real path
        for (let i = 0; i < hops.length; i++) {
            if (hops[i].charAt(0) == "!" && meshIsValidRelayToken(hops[i])
                && meshRelayRest(hops[i]) < meshRelayMax(hops[i])) {
                return;
            }
        }

        // Collect the stations that really transmitted the packet (in order)
        let stations: string[] = [];
        for (let i = 0; i < hops.length; i++) {
            if (meshIsUsedStation(hops[i])) {
                stations.push(hops[i].substr(0, hops[i].length - 1));
            }
        }

        // The last station is the one we have heard directly.
        // The route to station k is the reversed list of all stations after k.
        for (let k = 0; k < stations.length; k++) {
            let back: string[] = [];
            for (let j = stations.length - 1; j > k; j--) {
                back.push(stations[j]);
            }
            this.addRoute(stations[k], back.join(","), lifetime);
        }
    }

    /**
     * learns a route
     * @param otherStation target StationId for the route
     * @param newRoute A route in the format "HOP1,HOP2,HOP3" ("" = direct)
     * @param lifetime Time in seconds till the route becomes invalid
     */
    addRoute(otherStation: string, newRoute: string, lifetime = 30) {
        let expiry = control.millis() + lifetime * 1000;
        let idx = this.destinations.indexOf(otherStation);
        if (idx >= 0) {
            this.routes[idx] = newRoute;
            this.expiries[idx] = expiry;
            return;
        }
        this.destinations.push(otherStation);
        this.routes.push(newRoute);
        this.expiries.push(expiry);
    }

    /**
     * Deletes the expired routes from the internal routing list.
     */
    private removeExpiredRoutes() {
        let now = control.millis();
        for (let i = this.destinations.length - 1; i >= 0; i--) {
            if (now > this.expiries[i]) {
                this.destinations.removeAt(i);
                this.routes.removeAt(i);
                this.expiries.removeAt(i);
            }
        }
    }
}

//----------------------------------------------------------------------------------------
// Implementation of the Meshnetwork itself
// ---------------------------------------------------------------------------------------
class Mesh {
    private routes: RoutingTable;
    private stationID: string;        // Name of the mesh node
    private maxPacketSize: number;    // How long can a packet be ? (depends on the baselayer)
    private lastError: string = "";   // The last error
    private seq: number;              // Next sequence number (counter, see seqLength)

    // Duplicate detection: packets we have already forwarded / delivered
    private relayed: ExpiringSet = new ExpiringSet(32);
    private delivered: ExpiringSet = new ExpiringSet(32);

    // Non blocking transmit queue
    private txPackets: string[] = [];
    private txDue: number[] = [];

    /** Maximum random delay (ms) before a packet is forwarded (collision avoidance) */
    maxJitterMs = 1000;
    /** Lifetime (s) of learned routes and duplicate detection entries */
    cacheLifetime = 30;
    /** Maximum number of packets waiting in the transmit queue */
    maxQueueLength = 16;
    /**
     * Number of characters of the automatically generated sequence number (base 62).
     * 0 = send without sequence number (duplicate detection by payload, like APRS),
     * 1 = 62 values (default, saves space on the micro:bit), 2 = 3844, 3 = 238328, max 4
     */
    seqLength = 1;

    /**
     * Creates a meshed System where
     * @param stationID The unique name of the station
     * @param maxPacketSize the maximum packet size (19 for radio.sendString on the micro:bit)
     */
    constructor(stationID: string, maxPacketSize = 19) {
        if (!meshIsValidId(stationID)) {
            // Fail fast: an invalid station id would corrupt every packet
            control.panic(801);
        }
        this.stationID = stationID;
        this.maxPacketSize = maxPacketSize;
        this.setDefaultRoute("!3-3");

        // Start with a random sequence number, so that a restarted station
        // is not mistaken for a duplicate by the other stations
        this.seq = randint(0, 14776335); // 62^4 - 1

        control.inBackground(() => {
            while (true) {
                this.processTxQueue();
                basic.pause(10);
            }
        });
    }

    /**
     * Sets the default route. A call to this function will flush the current routing table
     * and create a new one.
     * "!3-3" (default) floods without learning, "?3-3" floods and allows the receiver to
     * learn routes (but needs more space in the packet).
     */
    setDefaultRoute(defaultRoute: string) {
        this.routes = new RoutingTable(defaultRoute);
    }

    /**
     * Helper function that indicates that something went wrong
     */
    private fail(reason: string): boolean {
        this.lastError = reason;
        return false;
    }

    /**
     * returns the last error
     */
    getLastError(): string {
        return this.lastError;
    }

    /**
     * Puts a packet into the transmit queue.
     * @param delayMs time to wait before the packet is sent
     */
    private enqueue(packet: string, delayMs: number) {
        if (this.txPackets.length >= this.maxQueueLength) {
            // Queue full -> drop the oldest packet
            this.txPackets.removeAt(0);
            this.txDue.removeAt(0);
        }
        this.txPackets.push(packet);
        this.txDue.push(control.millis() + delayMs);
    }

    /**
     * Sends the first packet in the queue that is due. Called periodically from
     * the background loop (and can be called manually e.g. for tests).
     */
    processTxQueue() {
        let now = control.millis();
        for (let i = 0; i < this.txPackets.length; i++) {
            if (now >= this.txDue[i]) {
                let packet = this.txPackets[i];
                this.txPackets.removeAt(i);
                this.txDue.removeAt(i);
                this.sendPacket(packet);
                return;
            }
        }
    }

    /**
     * Encodes the sequence counter as base 62 string with seqLength characters
     */
    private nextSeq(): string {
        let len = Math.max(0, Math.min(4, this.seqLength));
        let result = "";
        let value = this.seq;
        for (let i = 0; i < len; i++) {
            result = MESH_SEQ_CHARS.charAt(value % 62) + result;
            value = Math.idiv(value, 62);
        }
        this.seq = (this.seq + 1) % 14776336; // 62^4
        return result;
    }

    /**
     * A simple function that allows to send a message to one microbit
     *
     * @param destination Station where the message should be sent to
     * @param payload Content that should be sent (any characters allowed)
     * @param seq optional own sequence number (e.g. "12345"). If omitted, one is generated
     *            automatically (see seqLength). Pass "" to send without sequence number.
     */
    sendMessage(destination: string, payload: string, seq?: string): boolean {
        if (!meshIsValidId(destination)) {
            return this.fail("Bad destination");
        }
        if (seq === undefined || seq === null) {
            seq = this.nextSeq();
        }
        else if (seq.length > 0 && !meshIsValidId(seq)) {
            return this.fail("Bad sequence number");
        }

        let route = this.routes.getRouteTo(destination);
        let path = this.stationID + "*";
        if (route.length > 0) {
            path = path + "," + route;
        }

        let target = destination;
        if (seq.length > 0) {
            target = target + "#" + seq;
        }

        let packet = path + ">" + target + ":" + payload;
        if (packet.length > this.maxPacketSize) {
            return this.fail("Packet too big");
        }

        this.enqueue(packet, 0);
        return true;
    }

    /**
     * A callback method which is called once per received message.
     *
     * @param source The name of the station where the message was originated from
     * @param payload The payload which was sent
     */
    onMessageReceived = (source: string, payload: string) => { }

    /**
     * A callback method whenever the meshnode should send something.
     * This one should be connected to the radio interface
     */
    sendPacket = (packet: string) => { };

    /**
     * We receive something so lets process this
     */
    public processReceivedPacket(receivedString: string) {
        // Split "PATH>DEST[#SEQ]:PAYLOAD" at the FIRST ':' only -> payload may contain ':'
        let colon = receivedString.indexOf(":");
        if (colon < 0) {
            return;
        }
        let header = receivedString.substr(0, colon);
        let payload = receivedString.substr(colon + 1);

        // Analyze the header
        let gt = header.indexOf(">");
        if (gt < 0) {
            return;
        }
        let path = header.substr(0, gt);
        let target = header.substr(gt + 1);            // "DEST" or "DEST#SEQ"
        let destination = target;
        let seq = "";
        let hash = target.indexOf("#");
        if (hash >= 0) {
            destination = target.substr(0, hash);
            seq = target.substr(hash + 1);              // everything between '#' and ':'
            if (!meshIsValidId(seq)) {
                return; // "#" without (valid) sequence number
            }
        }
        if (!meshIsValidId(destination)) {
            return;
        }

        let hops = path.split(",");
        if (!meshIsUsedStation(hops[0])) {
            return; // the source must be the first (used) hop
        }
        let source = hops[0].substr(0, hops[0].length - 1);
        if (!meshIsValidId(source)) {
            return;
        }

        // Unique key of this message: sequence number if present, otherwise the payload
        let msgKey = source + ">" + destination;
        if (seq.length > 0) {
            msgKey = msgKey + "#" + seq;
        }
        else {
            msgKey = msgKey + ":" + payload;
        }

        //  Are we the destination ?
        if (destination == this.stationID) {
            // Flooding delivers several copies -> report only the first one
            if (this.delivered.has(msgKey)) {
                return;
            }
            this.delivered.add(msgKey, this.cacheLifetime);

            // Remember the route the packet took (but in reverse order)
            this.routes.addReverseRoutes(hops, this.cacheLifetime);

            this.onMessageReceived(source, payload);
            return;
        }

        //  If we have already transmitted this packet then do not reprocess it
        //  (exact compare of every hop - "R7*" must not match "AR7*")
        if (hops.indexOf(this.stationID + "*") >= 0) {
            return;
        }

        //  Find the last processed hop (used station or exhausted relay)
        let lastUsed = 0;
        for (let i = 0; i < hops.length; i++) {
            if (meshIsUsedStation(hops[i])) {
                lastUsed = i;
            }
            else if (meshIsValidRelayToken(hops[i]) && meshRelayRest(hops[i]) == 0) {
                lastUsed = i;
            }
        }

        //  Only the NEXT hop is relevant. (Otherwise every station that overhears the
        //  packet early could jump in at a relay token that comes after other hops.)
        let next = lastUsed + 1;
        if (next >= hops.length) {
            return;
        }
        let hop = hops[next];

        let newPacket: string;

        if (hop == this.stationID) {
            // Explicit hop -> mark ourself as used
            hops[next] = this.stationID + "*";
            newPacket = hops.join(",") + ">" + target + ":" + payload;
        }
        else if (meshIsValidRelayToken(hop)) {
            let relayMax = meshRelayMax(hop);
            let relayRest = meshRelayRest(hop);
            if (relayRest <= 0) {
                return;
            }

            let anonymousToken = "!" + relayMax + "-" + (relayRest - 1);
            if (hop.charAt(0) == "!") {
                // Relay without adding our callsign
                hops[next] = anonymousToken;
            }
            else {
                // Relay with insertion of our own callsign
                hops[next] = this.stationID + "*,?" + relayMax + "-" + (relayRest - 1);
            }
            newPacket = hops.join(",") + ">" + target + ":" + payload;

            // Not enough space for our callsign -> fall back to an anonymous relay
            if (newPacket.length > this.maxPacketSize && hop.charAt(0) == "?") {
                hops[next] = anonymousToken;
                newPacket = hops.join(",") + ">" + target + ":" + payload;
            }
        }
        else {
            // Not for us
            return;
        }

        if (newPacket.length > this.maxPacketSize) {
            this.fail("Packet too big to forward");
            return;
        }

        //  Never forward the same message twice
        if (this.relayed.has(msgKey)) {
            return;
        }
        this.relayed.add(msgKey, this.cacheLifetime);

        //  Send it after a random delay (non blocking)
        this.enqueue(newPacket, randint(0, this.maxJitterMs));
    }
}
//-------------------------------------------------------------------------------------------
let myName = "R7";
let mesh = new Mesh(myName);

radio.setGroup(42);

// Connect the Radio interface to the mesh implementation
radio.onReceivedString(onRadioReceivedString);
function onRadioReceivedString(packet: string) {
    console.log(myName + " <=\t" + packet);
    mesh.processReceivedPacket(packet);
}

mesh.sendPacket = function (packet: string) {
    console.log(myName + " =>\t" + packet);
    radio.sendString(packet);
}

// Callback if the Mesh Network has received a Message
// This function is called once per Message (duplicates are filtered)
mesh.onMessageReceived = function (source: string, payload: string) {
    serial.redirectToUSB()
    serial.writeLine(source + ":" + payload)
    basic.showString(payload)
};

// Simulate a received Package (sequence number "a", payload "WASSUP")
mesh.processReceivedPacket("E3*,!2-1>UP#a:WASSUP");

// Send a test message
input.onButtonPressed(Button.A, function on_button_pressed_a() {
    if (mesh.sendMessage("UP", myName) == false) {
        basic.showString(mesh.getLastError())
    }
})

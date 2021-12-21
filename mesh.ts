
//----------------------------------------------------------------------------------------
// A Simple routingtable implementation
// ---------------------------------------------------------------------------------------
class RoutingTable {
    // Stores the routes in the format "DEST<expiry:HOP1,HOP2,HOPn"
    private routeTable: Array<string> = [];
    private defaultRoute: string;

    constructor(defaultRoute: string) {
        this.defaultRoute = defaultRoute;
    }

    /**
     * Gets the route to the station. If the route is no known, then the
     * default route will be returned
     * 
     * @returns route oder default route
     */
    getRouteTo(otherStation: string): string {
        // Householding
        this.removeExpiredRoutes();

        // Search the route
        let i: number;
        for (i = this.routeTable.length - 1; i >= 0; i--) {
            let rt: string = this.routeTable.get(i);

            let dest: string = rt.split(":")[0];
            let route: string = rt.split(":")[1];

            let destinationId: string = dest.split("<")[0];
            let expiry: number = parseInt(dest.split("<")[1]);

            if (destinationId == otherStation) {
                return route;
            }
        }

        return this.defaultRoute;
    }

    /**
     * Adds a route from a path of a packet. This function can be used to add routes from packages 
     * that have been received and that you want to have a return Route
     */
    addReverseRoutes(path: string, lifetime = 30) {
        // The path looks like this "E3*,E5*,E9*,?2-1,XYZ*"
        // This means that we have a route to E3 via E5 -> E9 -> XYZ

        //  find the hops that have not been processed yet
        let hops = path.split(",")

        while (hops.length > 1) {
            let destination = hops[0].replaceAll("*", "");

            hops = hops.slice(1);
            hops.reverse();

            //  find last used stationindex
            let i: number;
            let route: string[] = [];
            for (i = 0; i < hops.length; i++) {
                if (hops[i].includes("*")) {
                    route.push(hops[i].replaceAll("*", ""));
                }
            }

            // and finally remember the route if it is more than 1 hop (then it would be direct)
            // and if it does not contain the KEY
            if (route.length > 0 && destination.includes("?") == false) {
                this.addRoute(destination, route.join(","));
            }
            hops.reverse();
        }
    }


    /**
     * learns a route
     * @param otherStation target StationId for the route
     * @param route A route in the format "HOP1,HOP2,HOP3"
     * @param lifetime Time in seconds till the route becomes invalid
     */
    addRoute(otherStation: string, newRoute: string, lifetime = 30) {
        let i: number;

        // Update the route
        for (i = this.routeTable.length - 1; i >= 0; i--) {
            let rt: string = this.routeTable.get(i);

            let dest: string = rt.split(":")[0];
            let route: string = rt.split(":")[1];

            let destinationId: string = dest.split("<")[0];
            let expiry: number = parseInt(dest.split("<")[1]);

            if (otherStation == destinationId) {
                this.routeTable.set(i, otherStation + "<" + (control.millis() + lifetime * 1e3).toString() + ":" + newRoute);
                return;
            }
        }

        // Route is not in table (yet) -> Add it !
        this.routeTable.push(otherStation + "<" + (control.millis() + lifetime * 1e3).toString() + ":" + newRoute);
    }

    /**
     * Deletes the expired routes from the internal routing List.
     */
    private removeExpiredRoutes() {
        let i: number;
        for (i = this.routeTable.length - 1; i >= 0; i--) {
            let rt: string = this.routeTable.get(i);

            let dest: string = rt.split(":")[0];
            let route: string = rt.split(":")[1];

            let destinationId: string = dest.split("<")[0];
            let expiry: number = parseInt(dest.split("<")[1]);

            if (control.millis() > expiry) {
                this.routeTable.removeAt(i);
            }
        }
    }
}

//----------------------------------------------------------------------------------------
// Implementation of the Meshnetwork itself
// ---------------------------------------------------------------------------------------
/**
 * Packets are Meshinternal information that can be sent an a shared medium like radio
  */
class Mesh {
    private routes: RoutingTable;
    private stationID: string; // Name of the mesh node
    private maxPacketSize: number; // How long can a message be ? (depends on the baselayer)
    private lastError: string; // The last error

    private relayedMessages: Array<string> = []; // Relayed messages

    /**
     * Creates a meshed System where
     * @param stationID The unique name of the station
     * @param the maximum packet size (18 for microbit v2 radio)
     */
    constructor(stationID: string, maxPacketSize = 18) {
        this.stationID = stationID;
        this.setDefaultRoute("?3-3");
        this.maxPacketSize = maxPacketSize;
    }

    /**
    * Sets the default routing tbale. A call to this funtion will flush the current routing table
    * and create a new one.
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
     * Checks if the message has been relayed yet
     */
    private hasBeenRelayed(source:string , destination:string , message:string): boolean
    {
        return false;
    }

    /**
     * A simple function that allows to send a message to one microbit
     * 
     * @param destination Station where the message should be sent to
     * @param content Content that should be sent
     */
    sendMessage(destination: string, payload: string): boolean {
        let message: string;
        let route = this.routes.getRouteTo(destination);
        let header: string;

        if (route.length > 0) {
            header = "" + this.stationID + "*," + route + ">" + destination + ":"
        }
        else {
            header = "" + this.stationID + "*>" + destination + ":"
        }

        let currentPacketSize = header.length + payload.length;

        if (header.length + payload.length > this.maxPacketSize) {
            // The path consumes the whole header
            // We can not transmit anything
            return this.fail("Packet too big");
        }

        message = header + payload;
        this.sendPacket(message)
        return true;
    }

    /**
     * A callback method which is called if a message is received.
     * 
     * @param source The name of the station where the message was originated from
     * @param path The paht the message took
     * @param content The payload which was sent
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
        let i: number;
        let newMessage: string;
        let relayMax: number;
        let relayNow: number;

        let header = receivedString.split(":")[0]
        let message = receivedString.split(":")[1]

        // Analyze the header
        let path = header.split(">")[0]
        let destination = header.split(">")[1]

        //  find the hops that have not been processed yet
        let hops = path.split(",")
        let source = hops[0].slice(0, -1);

        //  Check if we are the destination
        if (destination == this.stationID) {
            //  Yes 

            // Remember the route the package took (but in reverse order)
            this.routes.addReverseRoutes(path);

            // and call the callback function
            this.onMessageReceived(source, message)
            return;
        }

        //  If we have already passed this message then do not reprocess it
        if (path.includes(this.stationID + "*")) {
            // do nothing (on purpose)   
            return; 
        }

        //  find last used stationindex
        let lastUsed = 0
        for (i = 0; i < hops.length; i++) {
            //  Used station

            if (hops[i].substr(-1) == "*") {
                lastUsed = Math.max(lastUsed, i)
            }

            //  Used relay
            if (hops[i].includes("?") && hops[i].substr(-2) == "-0") {
                lastUsed = Math.max(lastUsed, i)
            }
        }


        //  process the remeaning hops
        for (i = lastUsed + 1; i < hops.length; i++) {
            //  Should we retransmit the message ?
            if (hops[i] == this.stationID) {
                //  Wait a little bit
                basic.pause(Math.random() * 1000)

                //  Mark ourself as used
                hops[i] = this.stationID + "*"

                //  Reassemble the message
                newMessage = hops.join(",") + ">" + destination + ":" + message

                // And send it
                this.sendPacket(newMessage)

                // Since we have sent the message, we can stop processing the message further
                break;
            }

            // Should we act as a relay ?
            if (hops[i].indexOf("?") >= 0) {

                if (this.hasBeenRelayed(source, destination, message))
                {
                    // Do nothing - because we have already relayed the packet
                    return;
                }

                //  Wait a little bit
                basic.pause(Math.random() * 1000)

                //  Reformat the message
                relayMax = parseInt(hops[i].slice(1).split("-")[0])
                relayNow = parseInt(hops[i].slice(1).split("-")[1])

                //  Insert ourself, decemrent the relay counter and retransmit the message
                hops[i] = this.stationID + "*" + ",?" + relayMax + "-" + (relayNow - 1)
                newMessage = hops.join(",") + ">" + destination + ":" + message
                this.sendPacket(newMessage)

                // Since we have relayed the message, we can stop processing the message further
                break;
            }
        }
    }
}
//-------------------------------------------------------------------------------------------

let mesh = new Mesh("HG");

// Connect the Radio interface to the mesh implementation
radio.onReceivedString(onRadioReceivedString);
function onRadioReceivedString(packet: string) {
    console.log("HG <=\t" + packet);
    mesh.processReceivedPacket(packet);
}

mesh.sendPacket = function (packet: string) {
    console.log("HG =>\t" + packet);
    radio.sendString(packet);
}

// Simulate a received Package
//mesh.processReceivedPacket("E3*,?2-1>R7:WASSUP");

// Callback if the Mesh Network has received a Message
// This function is called one per Message (which could on the layer below be more than one call)
mesh.onMessageReceived = function (source: string, payload: string) {
    serial.redirectToUSB()
    serial.writeLine(source + ":" + payload)
    basic.showString(payload)
};

// Send a test message
input.onButtonPressed(Button.A, function on_button_pressed_a() {
    if (mesh.sendMessage("UP", "ABCDEF") == false) {
        basic.showString(mesh.getLastError())
    }
})

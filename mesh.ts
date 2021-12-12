
// Config Parameters
let stationID = "R7"

//----------------------------------------------------------------------------------------
class RoutingTable
{
    // Stores the routes in the format "DEST<expiry:HOP1,HOP2,HOPn"
    private routeTable: Array<string> = [];
    private defaultRoute: string;

    constructor(defaultRoute:string)
    {
        this.defaultRoute = defaultRoute;
    }

    /**
     * Gets the route to the station. If the route is no known, then the
     * default route will be returned
     * 
     * @returns route oder default route
     */
    getRouteTo(otherStation:string): string
    {
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
    addReverseRoutes(path: string, lifetime = 30) 
    {
        // The path looks like this "E3*,E5*,E9*,ANY2-1,XYZ*"
        // This means that we have a route to E3 via E5 -> E9 -> XYZ

        //  find the hops that have not been processed yet
        let hops = path.split(",")

        while(hops.length > 1)
        {
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
            if (route.length > 0 && destination.includes("ANY") == false)
            {
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
    addRoute(otherStation: string, newRoute: string, lifetime = 30)
    {
        let i: number;

        // Update the route
        for (i = this.routeTable.length-1; i >= 0; i--) {
            let rt: string = this.routeTable.get(i);

            let dest: string = rt.split(":")[0];
            let route: string = rt.split(":")[1];

            let destinationId: string = dest.split("<")[0];
            let expiry: number = parseInt(dest.split("<")[1]);

            if (otherStation == destinationId) 
            {
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
    private removeExpiredRoutes()
    {
        let i:number;
        for (i = this.routeTable.length - 1; i >= 0; i--)
        {
            let rt:string = this.routeTable.get(i);
            
            let dest: string = rt.split(":")[0];
            let route:string = rt.split(":")[1];

            let destinationId:string = dest.split("<")[0];
            let expiry: number = parseInt(dest.split("<")[1]);

            if(control.millis() > expiry)
            {
                this.routeTable.removeAt(i);
            }
        }
    }
}

let routes = new RoutingTable("ANY3-3");
//-------------------------------------------------------------------------------------------
/**
 * A simple function that allows to send a message to one microbit
 * 
 * @param destination Station where the message should be sent to
 * @param content Content that should be sent
 */
function sendMessage(destination: string, payload: string) {
    let message: string;
    let route = routes.getRouteTo(destination);

    if (route.length > 0) 
    {
        message = "" + stationID + "*," + route + ">" + destination + ":" + payload
    }
    else 
    {
        message = "" + stationID + "*>" + destination + ":" + payload
    }

    radio.sendString(message)
}

/**
 * A callback method which is called if a message is received
 * 
 * @param source The name of the station where the message was originated from
 * @param path The paht the message took
 * @param content The payload which was sent
 */
function onMessageReceived(source: string, path: string, payload: string) {
    serial.writeLine(source + ":" + payload)
    basic.showString(payload)
}

//  We receive something
function on_received_string(receivedString: string) {
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

    //  Check if we are the destination
    if (destination == stationID) {
        //  Yes 
        
        // Remember the route the package took (but in reverse order)
        routes.addReverseRoutes(path);

        // and call the callback function
        onMessageReceived(hops[0].slice(0, -1), path, message)
        return;
    }

    //  If we have already passed this message then do not reprocess it
    if (path.includes(stationID + "*")) {
        // do nothing (on purpose)    
    }

    //  find last used stationindex
    let lastUsed = 0
    for (i = 0; i < hops.length; i++) {
        //  Used station

        if (hops[i].substr(-1) == "*") {
            lastUsed = Math.max(lastUsed, i)
        }

        //  Used relay
        if (hops[i].includes("ANY") && hops[i].substr(-2) == "-0") {
            lastUsed = Math.max(lastUsed, i)
        }
    }


    //  process the remeaning hops
    for (i = lastUsed + 1; i < hops.length; i++) {
        //  Should we retransmit the message ?
        if (hops[i] == stationID) {
            //  Wait a little bit
            basic.pause(Math.random() * 1000)

            //  Mark ourself as used
            hops[i] = stationID + "*"

            //  Reassemble the message
            newMessage = hops.join(",") + ">" + destination + ":" + message

            // And send it
            radio.sendString(newMessage)

            // Since we have sent the message, we can stop processing the message further
            break;
        }

        // Should we act as a relay ?
        if (hops[i].indexOf("ANY") >= 0) {
            //  Wait a little bit
            basic.pause(Math.random() * 1000)

            //  Reformat the message
            relayMax = parseInt(hops[i].slice(5).split("-")[0])
            relayNow = parseInt(hops[i].slice(5).split("-")[1])

            //  Insert ourself, decemrent the relay counter and retransmit the message
            hops[i] = stationID + "*" + ",ANY" + relayMax + "-" + (relayNow - 1)
            newMessage = hops.join(",") + ">" + destination + ":" + message
            radio.sendString(newMessage)

            // Since we have relayed the message, we can stop processing the message further
            break;
        }
    }
}

//-------------------------------------------------------------------------------------------

// Tests for the routing table implementation
let r = new RoutingTable("ANY3-3");
r.addRoute("R7", "U3,E5,E9", 20);
r.addRoute("A5", "R3,A2,A9");
r.addRoute("C4", "R3,A2,ANY2-2");

r.addReverseRoutes("E3*,E5*,E9*,H12,R8*,ANY2-1,XYZ");

r.addReverseRoutes("E3*,E5*,A,B*,C,X*");
basic.showString(r.getRouteTo("E5"));

control.waitMicros(10000000);
basic.showString(r.getRouteTo("R7"));


// The actual code
radio.onReceivedString(on_received_string)
serial.redirectToUSB()

// Simulate a received Package
on_received_string("E3*,E5*,E9,ANY2-1,XYZ>R7:WASSUP")

// Send a test message
input.onButtonPressed(Button.A, function on_button_pressed_a() {
    sendMessage("UPLINK", "Test123")
})

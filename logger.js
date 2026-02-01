class Logger {
    constructor(procname, verbose) {
        this.procname = procname;
        this.verbose = verbose;
    }

    child = name => new Logger(name, this.verbose);
    
    info = (...msg) => {
        console.info(this.getTimestamp('INFO'), ...msg);  
    }
    
    error = (...msg) => {
        console.error(this.getTimestamp('ERROR'), ...msg);
    }

    debug = (...msg) => {
        if (!this.verbose) return;
        console.debug(this.getTimestamp('DEBUG'), ...msg);  
    }

    getTimestamp(level) {
        return `${new Date().toISOString()} [${this.procname}] ${level}:`
    }
}

export default Logger;
<p align="center"><a href="https://resgate.io" target="_blank" rel="noopener noreferrer"><img width="100" src="docs/img/resgate-logo.png" alt="Resgate logo"></a></p>


<h2 align="center"><b>ResClient for Javascript</b><br/>Synchronize Your Clients</h2>
</p>

<p align="center">
<a href="http://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
<a href="https://www.npmjs.org/package/resclient"><img src="http://img.shields.io/npm/v/resclient.svg" alt="View on NPM"></a>
<a href="https://travis-ci.com/jirenius/resclient"><img src="https://travis-ci.com/jirenius/resclient.svg?branch=master" alt="Build Status"></a>
<a href="https://coveralls.io/github/jirenius/resclient?branch=master"><img src="https://coveralls.io/repos/github/jirenius/resclient/badge.svg?branch=master" alt="Coverage"></a>
</p>

---

Javascript client library implementing the RES-Client Protocol. Used to establish WebSocket connections to [Resgate](https://resgate.io), to get your data synchronized in real-time.

Visit [Resgate.io](https://resgate.io) for more information.

## Installation

With npm:
```sh
npm install resclient
```

With yarn:
```sh
yarn add resclient
```

## Example usage

```javascript
import ResClient from 'resclient';

const client = new ResClient('ws://localhost:8080/ws');

client.get('example.mymodel').then(model => {
    console.log(model.message);

    let onChange = () => {
        console.log("New message: " + model.message);
    };

    // Listen to changes for 5 seconds, eventually unsubscribing
    model.on('change', onChange);
    setTimeout(() => {
        model.off('change', onChange);
    }, 5000);
});
```

## Full examples

| Example | Description
| --- | ---
| [React](examples/book-collection-react/) | React client implementation of the Book Collection example.
| [Vue.js](examples/book-collection-vuejs/) | Vue.js client implementation of the Book Collection example.
| [Modapp](https://github.com/jirenius/resgate/tree/master/examples/book-collection) | Book Collection example from Resgate repository

> **Note**
>
> All examples are complete with both service and client.

## Documentation

[Markdown documentation](https://github.com/jirenius/resclient/blob/master/docs/docs.md)
let {
    InboxStream,
    CommentStream,
    SubmissionStream
} = require('snoostorm');
let Snoowrap = require('snoowrap');
let TurndownService = require('turndown');
let turndownService = new TurndownService();
let sqlite3 = require('sqlite3');
let {
    open
} = require('sqlite');

let db = null;
let client = null;

(async () => {
    // open the database
    db = await open({
        filename: 'database.db',
        driver: sqlite3.Database
    });

    const creds = require('./credentials.json');
    client = new Snoowrap(creds);

    const comments = new CommentStream(client, {
        subreddit: 'ethfinance',
        limit: 50,
        pollTime: 5000
    });
    comments.on('item', replyWithNitter);
    const inbox = new InboxStream(client, {
        limit: 20,
        pollTime: 5000,
        filter: 'unread'
    });
    inbox.on('item', handleInbox);
})();



async function replyWithNitter(comment) {
    try {
        const author = comment.author.name;
        const commentId = comment.id;
        const twitterlinks = comment.body_html.match(/<a href="https:\/\/twitter.com\/.*?">.*?<\/a>/gm);

        if (twitterlinks && twitterlinks.length > 0) {
            try {
                let authorOptedOut = await db.get('SELECT username FROM optouts WHERE username=:username LIMIT 1;', {
                    ':username': author
                });
                let alreadyReplied = await db.get('SELECT commentid FROM replies WHERE commentid=:commentid LIMIT 1;', {
                    ':commentid': commentId
                });

                if (!authorOptedOut && !alreadyReplied) {
                    let nitterlinks = [];
                    for (let index = 0; index < twitterlinks.length; index++) {
                        const twitterlink = twitterlinks[index];
                        nitterlinks.push(turndownService.turndown(twitterlink).replace(/https:\/\/twitter.com/gm, 'https://nitter.net'));
                    }

                    const replyText = nitterlinks.join('  \n\n');

                    console.log(comment.created_utc, commentId, replyText);
                    client.getComment(commentId).reply(replyText).then(async (reply) => {
                        console.log('nitter reply id', reply.id);
                        await db.run('INSERT INTO replies VALUES (:author, :commentid, :replyid, :timestamp);', {
                            ':author': author,
                            ':commentid': commentId,
                            ':replyid': reply.id,
                            ':timestamp': Date.now()
                        });

                    }, (reason) => console.error(reason));
                } else if (authorOptedOut) {
                    console.log(`Not replying to ${commentId} because ${author} opted out.`);
                } else if (alreadyReplied) {
                    console.log(`Not replying to ${commentId} because already replied to.`);
                }
            } catch (err) {
                console.error(comment);
                console.error(err);
            }
        }
    } catch (err) {
        console.error(err);
    }
}

async function handleInbox(message) {
    try {
        const msgId = message.id;
        const msgBody = message.body.toLowerCase().replace(/ /gm, '');
        const subject = message.subject.toLowerCase().replace(/ /gm, '');
        const author = message.author.name;

        if (msgBody.includes('optout') || subject.includes('optout')) {

            let authorOptedOut = await db.get('SELECT username FROM optouts WHERE username=:username;', {
                ':username': author
            });
            let alreadyReplied = await db.get('SELECT commentid FROM replies WHERE commentid=:commentid LIMIT 1;', {
                ':commentid': msgId
            });
            if (!authorOptedOut && !alreadyReplied) {
                await db.run('INSERT INTO optouts VALUES (:username, :timestamp);', {
                    ':username': author,
                    ':timestamp': Date.now()
                });
                console.log(`User ${author} opted out :(`);
                client.getComment(msgId).reply(':(').then(async (reply) => {
                    console.log('opt out reply id', reply.id);
                    await db.run('INSERT INTO replies VALUES (:author, :commentid, :replyid, :timestamp);', {
                        ':author': author,
                        ':commentid': msgId,
                        ':replyid': reply.id,
                        ':timestamp': Date.now()
                    });
                }, console.error);
            } else if (alreadyReplied) {
                console.log(`Not replying to ${msgId} because already replied to.`);
            } else if (authorOptedOut) {
                console.warn(`User ${author} already opted out.`);
                client.getComment(msgId).reply('You\'ve already opted out.').then(async (reply) => {
                    console.log('already opted out reply id', reply.id);
                    await db.run('INSERT INTO replies VALUES (:author, :commentid, :replyid, :timestamp);', {
                        ':author': author,
                        ':commentid': msgId,
                        ':replyid': reply.id,
                        ':timestamp': Date.now()
                    });
                }, console.error);
            }

        }
    } catch (err) {
        console.error(message);
        console.error(err);
    }
}
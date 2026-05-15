The Waiting Time Paradox, or, Why Is My Bus Always Late? | Pythonic Perambulations
Pythonic Perambulations
About
Archive
The Waiting Time Paradox, or, Why Is My Bus Always Late?
Thu 13 September 2018
Image Source: Wikipedia License CC-BY-SA 3.0
If you, like me, frequently commute via public transit, you may be familiar with the following situation:
You arrive at the bus stop, ready to catch your bus: a line that advertises arrivals every 10 minutes. You glance at your watch and note the time... and when the bus finally comes 11 minutes later, you wonder why you always seem to be so unlucky.
Naïvely, you might expect that if buses are coming every 10 minutes and you arrive at a random time, your average wait would be something like 5 minutes. In reality, though, buses do not arrive exactly on schedule, and so you might wait longer. It turns out that under some reasonable assumptions, you can reach a startling conclusion:
When waiting for a bus that comes on average every 10 minutes, your average waiting time will be 10 minutes.
This is what is sometimes known as the waiting time paradox.
I've encountered this idea before, and always wondered whether it is actually true... how well do those "reasonable assumptions" match reality? This post will explore the waiting time paradox from the standpoint of both simulation and probabilistic arguments, and then take a look at some real bus arrival time data from the city of Seattle to (hopefully) settle the paradox once and for all.
The Inspection Paradox ¶
If buses arrive exactly every ten minutes, it's true that your average wait time will be half that interval: 5 minutes. Qualitatively speaking, it's easy to convince yourself that adding some variation to those arrivals will make the average wait time somewhat longer, as we'll see here.
The waiting time paradox turns out to be a particular instance of a more general phenomenon, the inspection paradox, which is discussed at length in this enlightening post by Allen Downey: The Inspection Paradox Is Everywhere.
Briefly, the inspection paradox arises whenever the probability of observing a quantity is related to the quantity being observed. Allen gives one example of surveying university students about the average size of their classes. Though the school may truthfully advertise an average of 30 students per class, the average class size as experienced by students can be (and generally will be) much larger. The reason is that there are (of course) more students in the larger classes, and so you oversample large classes when computing the average experience of students.
In the case of a nominally 10-minute bus line, sometimes the span between arrivals will be longer than 10 minutes, and sometimes shorter, and if you arrive at a random time, you have more opportunities to encounter a longer interval than to encounter a shorter interval. And so it makes sense that the average span of time experienced by riders will be longer than the average span of time between buses, because the longer spans are over-sampled.
But the waiting time paradox makes a stronger claim than this: when the average span between arrivals is N minutes, the average span experienced by riders is 2 N minutes. Could this possibly be true?
Simulating Wait Times ¶
To convince ourselves that the waiting time paradox is making a reasonable claim, let's start by simulating a stream of buses that arrive at an average of 10 minutes. For the sake of numerical accuracy, we will simulate a large number of bus arrivals: one million buses (or approximately 19 years of round-the-clock 10-minute headways):
In [1]:
import numpy as np

N = 1000000  # number of buses
tau = 10  # average minutes between arrivals

rand = np.random.RandomState(42)  # universal random seed
bus_arrival_times = N * tau * np.sort(rand.rand(N))
Just to confirm we've done things correctly, let's check that the mean interval is close to τ= 10:
In [2]:
intervals = np.diff(bus_arrival_times)
intervals.mean()
Out[2]:
9.9999879601518398
With these bus arrivals simulated, we can now simulate the arrival of a large number of passengers to the bus stop during this span, and compute the wait time that each of them experiences. Let's encapsulate this in a function for later use:
In [3]:
def simulate_wait_times(arrival_times,
                        rseed=8675309,  # Jenny's random seed
                        n_passengers=1000000):
    rand = np.random.RandomState(rseed)
    
    arrival_times = np.asarray(arrival_times)
    passenger_times = arrival_times.max() * rand.rand(n_passengers)

    # find the index of the next bus for each simulated passenger
    i = np.searchsorted(arrival_times, passenger_times, side='right')

    return arrival_times[i] - passenger_times
We can then simulate some wait times and compute the average:
In [4]:
wait_times = simulate_wait_times(bus_arrival_times)
wait_times.mean()
Out[4]:
10.001584206227317
The average wait time is also close to 10 minutes, just as the waiting time paradox predicted.
Digging Deeper: Probabilities & Poisson Processes ¶
How can we understand what's going on here?
Fundamentally, this is an instance of the inspection paradox, in which the probability of observing a value is related to the value itself. Let's denote by p( T) the distribution of intervals T between buses as they arrive at a bus stop. In this notation, the expectation value of the arrival times is E[ T]= ∫ ∞ 0 T p( T) d T
In the above simulation, we had chosen E[ T]= τ= 10 minutes.
When a rider arrives at a bus stop at a random time, the probability of the time interval they experience will be affected by p( T), but also by T itself: the longer the interval, the larger the probability is that a passenger will experience it.
So we can write the distribution of arrival times experienced by passengers: p e x p( T) ∝ T p( T)
The constant of proportionality comes from normalizing the distribution: p e x p( T)= T p( T) ∫ ∞ 0 T p( T) d T
Comparing to above we see this simplifies to p e x p( T)= T p( T) E[ T]
The expected wait time E[ W] will then be half of the expected interval experienced by passengers, so we can write E[ W]= 1 2 E e x p[ T]= 1 2 ∫ ∞ 0 T p e x p( T) d T
which can be rewritten in a more suggestive way: E[ W]= E[ T 2] 2 E[ T]
and now all that remains is for us to choose a form for p( T) and compute the integrals.
Choosing p(T) ¶
With this formalism worked out, what is a reasonable distribution to use for p( T)? We can get a picture of the p( T) distribution within our simulated arrivals by plotting a histogram of the intervals between arrivals:
In [5]:
%matplotlib inline
import matplotlib.pyplot as plt
plt.style.use('seaborn')

plt.hist(intervals, bins=np.arange(80), density=True)
plt.axvline(intervals.mean(), color='black', linestyle='dotted')
plt.xlabel('Interval between arrivals (minutes)')
plt.ylabel('Probability density');
The vertical dotted line here shows the mean interval of about 10 minutes. This looks very much like an exponential distribution, and that is no accident: our simulation of bus arrival times as uniform random numbers very closely approximates a Poisson process, and for such a process it can be shown that the distribution of intervals between arrivals is exponential.
(Side note: In our case this is only approximately exponential; in reality the intervals T between N uniformly sampled points within a timespan N τ follow the Beta distribution: T/( N τ) ∼ B e t a[ 1, N], which in the large N limit approaches T ∼ E x p[ 1/ τ]. See, e.g. this StackExchange post, or this twitter thread for more details).
An exponential distribution of intervals implies that the arrival times follow a Poisson process. To double-check this reasoning, we can confirm that it matches another property of a Poisson process: the number of arrivals within a fixed span of time will be Poisson-distributed. Let's check this by binning our simulated arrivals into hourly blocks:
In [6]:
from scipy.stats import poisson

# count the number of arrivals in 1-hour bins
binsize = 60
binned_arrivals = np.bincount((bus_arrival_times // binsize).astype(int))
x = np.arange(20)

# plot the results
plt.hist(binned_arrivals, bins=x - 0.5, density=True, alpha=0.5, label='simulation')
plt.plot(x, poisson(binsize / tau).pmf(x), 'ok', label='Poisson prediction')
plt.xlabel('Number of arrivals per hour')
plt.ylabel('frequency')
plt.legend();
The close match between the empirical and theoretical values gives confidence that our interpretation is correct: for large N, the arrival times we simulated above are well-described by a Poisson process, which implies exponentially-distributed arrival intervals.
That means we can write the probability distribution: p( T)= 1 τ e− T/ τ
Plugging this into the above results, we find that the average waiting time experienced by a person is E[ W]= ∫ ∞ 0 T 2 e− T/ τ 2 ∫ ∞ 0 T e− T/ τ= 2 τ 3 2( τ 2)= τ
For bus arrivals consistent with a Poisson process, the expected wait time for a passenger is identical to the average interval between arrivals.
A complementary way to reason about this is this: a Poisson process is a memoryless process, meaning that the history of events has no bearing on the expected time to the next event. So when you arrive at the bus stop, the average waiting time until the next bus is always the same: in our case, it is 10 minutes, and this is regardless of how long it has been since the previous bus! Along the same lines, it does not matter how long you have been waiting already: the expected time to the next arrival is always exactly 10 minutes: for a Poisson process, you get no "credit" for time spent waiting.
Waiting Times In Reality ¶
The above is well and good if real-world bus arrivals are actually described by a Poisson process, but are they?
Image Source: https://seattletransitmap.com/
To determine whether the waiting time paradox describes reality, we can dig into some data, available for download here: arrival_times.csv (3MB CSV file). The dataset contains scheduled and actual arrival times for Seattle's Rapid Ride lines C, D, and E at the 3rd & Pike bus stop in downtown Seattle, recorded during the second quarter of 2016 (huge thanks to Mark Hallenbeck of the Washington State Transportation Center for providing this data!).
In [7]:
import pandas as pd
df = pd.read_csv('arrival_times.csv')
df = df.dropna(axis=0, how='any')
df.head()
Out[7]:
OPD_DATE
VEHICLE_ID
RTE
DIR
TRIP_ID
STOP_ID
STOP_NAME
SCH_STOP_TM
ACT_STOP_TM
0
2016-03-26
6201
673
S
30908177
431
3RD AVE & PIKE ST (431)
01:11:57
01:13:19
1
2016-03-26
6201
673
S
30908033
431
3RD AVE & PIKE ST (431)
23:19:57
23:16:13
2
2016-03-26
6201
673
S
30908028
431
3RD AVE & PIKE ST (431)
21:19:57
21:18:46
3
2016-03-26
6201
673
S
30908019
431
3RD AVE & PIKE ST (431)
19:04:57
19:01:49
4
2016-03-26
6201
673
S
30908252
431
3RD AVE & PIKE ST (431)
16:42:57
16:42:39
The reason I sought data from Rapid Ride routes in particular is that for much of the day, the buses are scheduled at regular intervals of between 10 and 15 minutes — not to mention the fact that I'm a frequent passenger on the C-line.
Data Cleanup ¶
To start with, let's do a little bit of data cleanup to get it into a form that's easier to work with:
In [8]:
# combine date and time into a single timestamp
df['scheduled'] = pd.to_datetime(df['OPD_DATE'] + ' ' + df['SCH_STOP_TM'])
df['actual'] = pd.to_datetime(df['OPD_DATE'] + ' ' + df['ACT_STOP_TM'])

# if scheduled & actual span midnight, then the actual day needs to be adjusted
minute = np.timedelta64(1, 'm')
hour = 60 * minute
diff_hrs = (df['actual'] - df['scheduled']) / hour
df.loc[diff_hrs > 20, 'actual'] -= 24 * hour
df.loc[diff_hrs < -20, 'actual'] += 24 * hour
df['minutes_late'] = (df['actual'] - df['scheduled']) / minute

# map internal route codes to external route letters
df['route'] = df['RTE'].replace({673: 'C', 674: 'D', 675: 'E'}).astype('category')
df['direction'] = df['DIR'].replace({'N': 'northbound', 'S': 'southbound'}).astype('category')

# extract useful columns
df = df[['route', 'direction', 'scheduled', 'actual', 'minutes_late']].copy()

df.head()
Out[8]:
route
direction
scheduled
actual
minutes_late
0
C
southbound
2016-03-26 01:11:57
2016-03-26 01:13:19
1.366667
1
C
southbound
2016-03-26 23:19:57
2016-03-26 23:16:13
-3.733333
2
C
southbound
2016-03-26 21:19:57
2016-03-26 21:18:46
-1.183333
3
C
southbound
2016-03-26 19:04:57
2016-03-26 19:01:49
-3.133333
4
C
southbound
2016-03-26 16:42:57
2016-03-26 16:42:39
-0.300000
How Late Are Buses? ¶
There are essentially six different datasets within this table: the northbound and southbound directions for each of the C, D, and E lines. To get a feeling for their characteristics, let's plot a histogram of the actual minus scheduled arrival times for each of these six:
In [9]:
import seaborn as sns
g = sns.FacetGrid(df, row="direction", col="route")
g.map(plt.hist, "minutes_late", bins=np.arange(-10, 20))
g.set_titles('{col_name} {row_name}')
g.set_axis_labels('minutes late', 'number of buses');
You might expect that the buses stick closer to their schedule near the beginning of each one-way trip and show more spread near the end, and this is borne out in the data: the southbound C-line and northbound D and E lines are near the beginning of their respective routes, and in the opposite direction they are near the end.
Scheduled and Observed Arrival Intervals ¶
Let's next take a look at the observed and scheduled intervals between arrivals for these six routes. We'll start by using Pandas groupby functionality to compute these intervals:
In [10]:
def compute_headway(scheduled):
    minute = np.timedelta64(1, 'm')
    return scheduled.sort_values().diff() / minute

grouped = df.groupby(['route', 'direction'])
df['actual_interval'] = grouped['actual'].transform(compute_headway)
df['scheduled_interval'] = grouped['scheduled'].transform(compute_headway)
In [11]:
g = sns.FacetGrid(df.dropna(), row="direction", col="route")
g.map(plt.hist, "actual_interval", bins=np.arange(50) + 0.5)
g.set_titles('{col_name} {row_name}')
g.set_axis_labels('actual interval (minutes)', 'number of buses');
It's already clear that these don't look much like the exponential distribution of our model, but that is not telling us much yet: the distributions may be affected by non-constant scheduled arrival intervals.
Let's repeat the above chart, examining the scheduled rather than observed arrival intervals:
In [12]:
g = sns.FacetGrid(df.dropna(), row="direction", col="route")
g.map(plt.hist, "scheduled_interval", bins=np.arange(20) - 0.5)
g.set_titles('{col_name} {row_name}')
g.set_axis_labels('scheduled interval (minutes)', 'frequency');
This shows that the buses come at variety of arrival intervals thorughout the week, so we cannot evaluate the accuracy of the waiting time paradox from the distributions of raw arrival times.
Constructing Uniform Schedules ¶
Even though the scheduled arrival intervals are not uniform, there are a few particular intervals that have a large number of arrivals: for example, there are nearly 2000 northbound E-line buses with a scheduled interval of 10 minutes. In order to explore whether the waiting time paradox applies, let's group the data by line, direction, and scheduled interval, then re-stack these similar arrivals together as if they had happened in sequence. This should maintain all the relevant characteristics of the raw data, while making it easier to directly compare with the predictions of the waiting time paradox.
In [13]:
def stack_sequence(data):
    # first, sort by scheduled time
    data = data.sort_values('scheduled')
    
    # re-stack data & recompute relevant quantities
    data['scheduled'] = data['scheduled_interval'].cumsum()
    data['actual'] = data['scheduled'] + data['minutes_late']
    data['actual_interval'] = data['actual'].sort_values().diff()
    return data

subset = df[df.scheduled_interval.isin([10, 12, 15])]
grouped = subset.groupby(['route', 'direction', 'scheduled_interval'])
sequenced = grouped.apply(stack_sequence).reset_index(drop=True)
sequenced.head()
Out[13]:
route
direction
scheduled
actual
minutes_late
actual_interval
scheduled_interval
0
C
northbound
10.0
12.400000
2.400000
NaN
10.0
1
C
northbound
20.0
27.150000
7.150000
0.183333
10.0
2
C
northbound
30.0
26.966667
-3.033333
14.566667
10.0
3
C
northbound
40.0
35.516667
-4.483333
8.366667
10.0
4
C
northbound
50.0
53.583333
3.583333
18.066667
10.0
Using this cleaned data, we can plot the distribution of "actual" arrival intervals for each route, direction, and arrival frequency:
In [14]:
for route in ['C', 'D', 'E']:
    g = sns.FacetGrid(sequenced.query(f"route == '{route}'"),
                      row="direction", col="scheduled_interval")
    g.map(plt.hist, "actual_interval", bins=np.arange(40) + 0.5)
    g.set_titles('{row_name} ({col_name:.0f} min)')
    g.set_axis_labels('actual interval (min)', 'count')
    g.fig.set_size_inches(8, 4)
    g.fig.suptitle(f'{route} line', y=1.05, fontsize=14)
We see that for each line and schedule, the distribution of observed arrival intervals is nearly Gaussian, is peaked near the scheduled arrival interval, and has a standard deviation that is smaller near the beginning of the route (southbound for C, northbound for D/E) and larger near the end. Even without a statistical test, it's clear by eye that the actual arrival intervals are definitely not exponentially distributed, which is the basic assumption on which the waiting time paradox rests.
We can make use of the wait time simulation function we used above in order to find the average wait time for each bus line, direction, and schedule:
In [15]:
grouped = sequenced.groupby(['route', 'direction', 'scheduled_interval'])
sims = grouped['actual'].apply(simulate_wait_times)
sims.apply(lambda times: "{0:.1f} +/- {1:.1f}".format(times.mean(), times.std()))
Out[15]:
route  direction   scheduled_interval
C      northbound  10.0                  7.8 +/- 12.5
                   12.0                   7.4 +/- 5.7
                   15.0                   8.8 +/- 6.4
       southbound  10.0                   6.2 +/- 6.3
                   12.0                   6.8 +/- 5.2
                   15.0                   8.4 +/- 7.3
D      northbound  10.0                   6.1 +/- 7.1
                   12.0                   6.5 +/- 4.6
                   15.0                   7.9 +/- 5.3
       southbound  10.0                   6.7 +/- 5.3
                   12.0                   7.5 +/- 5.9
                   15.0                   8.8 +/- 6.5
E      northbound  10.0                   5.5 +/- 3.7
                   12.0                   6.5 +/- 4.3
                   15.0                   7.9 +/- 4.9
       southbound  10.0                   6.8 +/- 5.6
                   12.0                   7.3 +/- 5.2
                   15.0                   8.7 +/- 6.0
Name: actual, dtype: object
The average waiting times are are perhaps a minute or two longer than half the scheduled interval, but not equal to the scheduled interval as the waiting time paradox implied. In other words, the inspection paradox is confirmed, but the waiting time paradox does not appear to match reality.
Final Thoughts ¶
The waiting time paradox has been an interesting launching-point for a discussion that covered simulation, probability, and comparison of statistical assumptions with reality. Although we confirmed that real-world bus lines do follow some version of the inspection paradox, the above analysis shows pretty definitively that the core assumption behind the waiting time paradox — that the arrival of buses follows the statistics of a Poisson process — is not well-founded.
In retrospect, this is perhaps not all that surprising: a Poisson process is a memoryless process that assumes the probability of an arrival is entirely independent of the time since the previous arrival. In reality, a well-run bus system will have schedules deliberately structured to avoid this kind of behavior: buses don't begin their routes at random times throughout the day, but rather begin their routes on a schedule chosen to best serve the transit-riding public.
The larger lesson here is that you should be careful about the assumptions you bring to any data analysis task. A Poisson process is a good description for arrival time data — sometimes. But just because one type of data sounds like another type of data, it does not mean that assumptions valid for one are necessarily valid for the other. Often assumptions that seem correct on their face can lead to conclusions that don't match reality.
This post was written entirely in the Jupyter notebook. You can download this notebook, or see a static view on nbviewer.
simulation statistics
Comments
We were unable to load Disqus Recommendations. If you are a moderator please see our troubleshooting guide.
Also on Pythonic Perambulations
❮
Optimization of Scientific Code with Cython: …
8 years ago
8 comments
When to use Cython¶ Before I get to the videos, I wanted to say a few words about when and why you might choose Cython. With scientific Python code, before turning to Cython I'd suggest going as far as you can with vectorization. Vectorization involves the judicious use of built-in routines in NumPy, SciPy, Pandas, and other libraries to reduce the number of explicit for-loops in your code. It can work quite well in many situations, and doesn't require any sort of ...
Exploring Line Lengths in Python …
9 years ago
12 comments
I found it curious that a log-normal distribution fits both tweets and lines of code. Doing some digging, I found some literature on the subject of message lengths on the internet. This study finds that across languages and mediums, comment lengths follow a log-normal distribution quite closely. They propose a mechanism related to the Weber-Fechner law, which suggests a logarithmic scale in degrees of perception. It seems reasonable that lengths of code lines would respond to the same mechanism. As for ...
Conda: Myths and Misconceptions
10 years ago
52 comments
Myth #4: Creating conda in the first place was irresponsible & divisive¶ Reality: Conda's creators pushed Python's standard packaging to its limits for over a decade, and only created a second tool when it was clear it was the only reasonable way forward. According to the Zen of Python, when doing anything in Python "There should be one – and preferably only one – obvious way to do it." So why would the creators of conda muddy the field by introducing a ...
Installing Python Packages from a Jupyter …
8 years ago
61 comments
In software, it's said that all abstractions are leaky, and this is true for the Jupyter notebook as it is for any other software. I most often see this manifest itself with the following issue: I installed package X and now I can't import it in the notebook. Help! This issue is a perrennial source of StackOverflow questions (e.g. this, that, here, there, another, this one, that one, and this... etc.). Fundamentally the problem is usually rooted in the fact that the Jupyter ...
Exposing Python 3.6's Private Dict …
9 years ago
1 comment
I just got home from my sixth PyCon, and it was wonderful as usual. If you weren't able to attend—or even if you were—you'll find a wealth of entertaining and informative talks on the PyCon 2017 YouTube channel. Two of my favorites this year were a complementary pair of talks on Python dictionaries by two PyCon regulars: Raymond Hettinger's Modern Python Dictionaries A confluence of a dozen great ideas and Brandon Rhodes' The Dictionary Even Mightier (a followup of his PyCon ...
Simulating Chutes & Ladders in …
8 years ago
16 comments
This weekend I found myself in a particularly drawn-out game of Chutes and Ladders with my four-year-old. If you've not had the pleasure of playing it, Chutes and Ladders (also sometimes known as Snakes and Ladders) is a classic kids board game wherein players roll a six-sided die to advance forward through 100 squares, using "ladders" to jump ahead, and avoiding "chutes" that send you backward. It's basically a glorified random walk with visual aids to help you build a ...
A Practical Guide to the Lomb-Scargle …
9 years ago
9 comments
This week I published the preprint of a manuscript that started as a blog post, but quickly out-grew this medium: Understanding the Lomb-Scargle Periodogram. Figure 24 from Understanding the Lomb-Scargle Periodogram. The figure shows the true period vs the periodogram peak for a simulated dataset with an observing cadence typical of ground-based optical astronomy. The simulation reveals common patterns of failure of the Lomb-Scargle method that are not often discussed explicitly, but are straightforward to explain based on the intuition developed ...
Reproducible Data Analysis in Jupyter
9 years ago
35 comments
Jupyter notebooks provide a useful environment for interactive exploration of data. A common question I get, though, is how you can progress from this nonlinear, interactive, trial-and-error style of exploration to a more linear and reproducible analysis based on organized, packaged, and tested code. This series of videos presents a case study in how I personally approach reproducible data analysis within the Jupyter notebook. Each video is approximately 5-8 minutes; the videos are available in a YouTube Playlist. Alternatively, below you ...
❯
We were unable to load Disqus. If you are a moderator please see our troubleshooting guide.
14 comments
1
Login
Disqus
Facebook
X (Twitter)
Google
Microsoft
Apple
G
Join the discussion…
Comment
Log in with
or sign up with Disqus or pick a name
Disqus is a discussion network
Don't be a jerk or do anything illegal. Everything is easier that way.
Read full terms and conditions
This comment platform is hosted by Disqus, Inc. I authorize Disqus and its affiliates to:
Use, sell, and share my information to enable me to use its comment services and for marketing purposes, including cross-context behavioral advertising, as described in our Terms of Service and Privacy Policy, including supplementing that information with other data about me, such as my browsing and location data.
Contact me or enable others to contact me by email with offers for goods or services
Process any sensitive personal information that I submit in a comment. See our Privacy Policy for more information [-]
Acknowledge I am 18 or older [-]
I'd rather post as a guest
18
Discussion Favorited!
Favoriting means this is a discussion worth sharing. It gets shared to your followers' Disqus feeds, and gives the creator kudos! Find More Discussions Share
Tweet this discussion
Share this discussion on Facebook
Share this discussion via email
Copy link to discussion
Best
Newest
Oldest
−
+
Alfonso C. Betancort 8 years ago Here in Europe, I have an app from the bus company that tells me when the bus is arriving in real-time, so my median waiting time is below 1 minute. I get out from my home five minutes earlier than the arrival time... take the lift, open the main door, walk a block and get into the bus with the bus company NFC Card as most passengers do (a ticket is almost 40% cheaper using NFC than paying in cash). All the buses are monitored in real-time using gps and wireless connections and they adjust the time the next bus it's expected to arrive at the desired stop in every previous stop (and on the way when the distance between stops is larger than a 1,5 miles further. The mean distance between stops within the city is less than an US mile. If google could put his hands on all these datapoints, it would probably be able to predict future (30') traffic congestions throughout the city with near 95% accuracy. see more
15 Press the down arrow key to see users who liked this 1 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1x058cy
−
+ This comment was deleted.
−
+
−
+
Alfonso C. Betancort Guest 7 years ago edited Las Palmas de G.C. in the Canary Islands. Google haven't yet reached an agreement with the Port Authority with regards to using their transit data. They have not reached it yet with the biggest Taxi cooperative (80% of the Taxis are associated with it) to use their location feed. But we have apps from those compthat google's map api, the world upside down. see more
2 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/23nhdfq
Show more replies Show more replies Show more replies
−
+
S stefanvdwalt 8 years ago I very much enjoyed this blog post; I'm sure each individual has the experience that their waiting time equals tau almost every time :) Practical question: since you have some control over your arrival time, what is the best strategy to follow to minimize waiting time? see more
6 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1vplts5
Show more replies
−
+
M Michal Krych 8 years ago There is a simple explanation, why the waiting time paradox does not hold in real case. There has been an error/divergence from reality in simulation, when the author considered generation of bus arrivals. In reality buses try to be on time according to some schedule (can be every 10 minutes starting on some particular point in time) and then they are a little bit late or earlier in respect to each individual moment. If the distribution of being late/earlier deviations is narrow (e.g. normal distribution with small sigma), then waiting times are close to half of time between buses (e.g. 5 minutes). The fun starts, when the distribution is broad and there is a significant probability of large delays and early times. Then average waiting time increases. As usually it is not easy to say what random means and we have to look how real processes look like. Thank you for interesting article. see more
5 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1wxmrn1
Show more replies
−
+
Ron Aaronson 6 years ago edited Although the method used to generate the bus arrival times results in an average time between arrivals of ~10 minutes, the standard deviation of the average time between arrivals is also ~10 minutes, which seems unrealistically large. I generated arrival times where the standard deviation was ~5 minutes using the following code:
N = 100000
tau = 10
rand = np.random.RandomState(42)
bus_arrival_times = (N/2) * tau * np.sort(rand.rand(N))
addend = 0
for i in range(N):
    bus_arrival_times[i] += addend
    addend += 5
Then the average wait time became 6.25 minutes. Of course, the above distribution is not very realistic either because now there are no instances of the interval between two successive bus arrivals being less than 5 minutes. But to say that when the average arrival time is N, your average waiting time will be N is a very provocative statement that makes for an interesting article. But in the end it is also very misleading blanket statement. see more
3 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/28sj4ox
Show more replies
−
+
W wiml 8 years ago Great article. I have, unsurprisingly, spent a bunch of time thinking about this kind of problem while waiting at bus stops. Another thing that makes modeling bus traffic interesting is that it is very much not a memoryless process! Bus behavior is affected by its passengers — people take time to get on and off; empty stops can sometimes be skipped entirely; a full bus and a near-empty bus are socially rather different which I'd guess affects the likelihood of the driver having to deal with a disorderly passenger; etc. — and a bus affects the passenger load of other buses on its route. For example there's a system instability that I think any bus rider has noticed (probably only happens in a certain range of rider load). You'll see buses pair up, with a heavily loaded bus immediately followed by a nearly empty bus (or, sometimes, several). This can happen after a traffic accident / drawbridge / etc clears, but it can also happen in a super simple continuous model: The lead bus becomes loaded enough that it starts dropping behind schedule. As a result, it arrives at stops which have had a longer-than-typical waiting time since the previous bus, and (assuming a uniform rate of rider arrival at a stop) that means that the rider load experienced by that bus increases as its lateness does, making it even later. Meanwhile, the trailing bus(es) are experiencing a lighter passenger load, so they travel faster and stay close to schedule. Bus drivers do a few things to fix this problem (they'll sometimes leapfrog buses, or have the lead bus refuse passengers for a while) but I'd guess that when the bus system is in that part of its operating regime it's hard to prevent. see more
2 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1wx9yfz
Show more replies
−
+
LS Lincoln Swaine-Moore 7 years ago I'm a bit confused by two of the sentences under #The Inspection Paradox: > And so it makes sense that the average span of time experienced by riders will be longer than the average span of time between buses, because the longer spans are over-sampled. > But the waiting time paradox makes a stronger claim than this: when the average span between arrivals is N minutes, the average span experienced by riders is 2N minutes. Could this possibly be true? Given the statement of the waiting paradox above ("When waiting for a bus that comes on average every 10 minutes, your average waiting time will be 10 minutes."), is it possible these should say "longer than half the average span of time between buses" and "the average span experienced by riders is N minutes", respectively? Regardless, cool article--thanks for sharing. see more
1 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1xpon3b
−
+
jakevdp Mod Lincoln Swaine-Moore 7 years ago The average span of time between buses experienced by riders is 20 minutes, which results in an average waiting time of 10 minutes. Sorry I wasn't more clear about that. see more
2 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1xpor1n
−
+
LS Lincoln Swaine-Moore jakevdp 7 years ago Ah, yup, I was conflating those two things. Might be easier to think about the former in terms of "encountered by riders" rather than "experienced by riders", but I'm just picking nits now :) Thanks! see more
0 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1xpr3bh
Show more replies Show more replies Show more replies
−
+
А Алексей Власов 8 years ago Average for single person is not equal average for all people comes to bus station. see more
1 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1x24fjf
Show more replies
−
+
Alexander Meitiv 8 years ago Check out my posts on bus transportation: Whether you should wait for the express bus https://playingwithmodels.w... A possible mechanism for the bus bunching phenomenon: https://playingwithmodels.w... see more
1 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1wxcerr
Show more replies
−
+
A. Jesse Jiryu Davis 8 years ago This article is terrific, and I loved Downey's article on the inspection paradox too. Thanks for the thorough analysis. see more
0 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1wz6612
Show more replies
−
+
S spkxipkj 8 years ago Wonderful job. Thanks!!! see more
0 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1wxsrmc
Show more replies
−
+
Kamal Banga 8 years ago edited Here is the code I wrote some day...
  from itertools import accumulate
from statistics import mean
from bisect import bisect_left
from random import randint, sample, uniform, choice, choices, expovariate
def mean_of_experiments(experiment_func, N=100_000):
	'''Decorator to repeat any Bernoulli trial N times and return probability of success'''
	def wrapper(*args, **kwargs):
		return round(mean(experiment_func(*args, **kwargs) for _ in range(N)), 3)
	return wrapper
def boardings(scale=5.0, N=100_000):
	'''Simulates an experiment where arrival of buses at stop follows a Poisson process and finds avg. inter-arrival time at a random instant'''
	arrivals = list(accumulate(expovariate(lambd=1/scale) for _ in range(N)))
	
	@mean_of_experiments
	def wait():
		boarding_idx = bisect_left(arrivals, uniform(0, arrivals[-1]))
		missed_bus = 0 if boarding_idx == 0 else arrivals[boarding_idx - 1]
		return arrivals[boarding_idx] - missed_bus
	
	return wait()
see more
0 Press the down arrow key to see users who liked this 0 Press the down arrow key to see users who disliked this
Reply
Share ›
http://disq.us/p/1wxkei4
Show more replies
Load more comments
Subscribe Subscribed
Privacy
Do Not Sell My Data
Powered by Disqus
CC := gcc
CFLAGS := -O2 -Wall -Wextra -std=c11
LDFLAGS :=

BIN := tdx-seal
SRC := tdx_seal.c

all: $(BIN)

$(BIN): $(SRC)
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(BIN)

.PHONY: all clean

